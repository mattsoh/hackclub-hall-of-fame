#!/usr/bin/env node
// One command replacing the eight ad-hoc scripts in scripts/.
//
// Those eight shared no code: each carried its own copy of the channel id, the
// threshold, the pacing delays and a permalink parser (three of which split the
// timestamp differently), only two of the eight excluded the author's own star,
// two applied the per-channel limit, and they passed state between each other
// through CSV files in scripts/output/. Two of them could mass-post thousands of
// historical announcements from a single flag: `repostMissingToHallOfFame.js
// --all --apply` would have re-posted every announcement older than 90 days —
// about 5,500 of them — because it inferred "never announced" from absence in a
// 90-day scan of channel history.
//
// Nothing here can do that. Reads are read-only, writes need --apply, and the
// only way to post an announcement the rules wouldn't post on their own is to
// name it, one permalink at a time.
//
//   hof status                          counts, last reconcile, rules in force
//   hof check <#channel> [--hours N]    what's starred in a channel right now
//   hof pending [--hours N|--all]       messages that qualify but aren't announced
//   hof reconcile [--apply]             fix drift, post what was missed (dry by default)
//   hof post <permalink>… --apply       announce specific messages, ignoring the age rule
//   hof skip|unskip <permalink>…        never / do announce these
//   hof migrate                         create/upgrade the schema (the app also does this at boot)

import { WebClient } from "@slack/web-api";
import { RULES, SCAN, TIMING, requireEnv } from "./config";
import * as db from "./db";
import { log } from "./log";
import { announcementText, delay, liveStars, parsePermalink, permalinkOf, tsSeconds } from "./slack";
import { postAnnouncement, qualifies } from "./policy";
import { runReconcile } from "./reconcile";
import { explain, scanChannel } from "./scan";
import { statusLines } from "./status";

const MAX_EXPLICIT_POSTS = 25;

interface Args {
  verb: string;
  rest: string[];
  apply: boolean;
  all: boolean;
  hours?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { verb: argv[0] ?? "status", rest: [], apply: false, all: false };
  for (const arg of argv.slice(1)) {
    if (arg === "--apply") args.apply = true;
    else if (arg === "--all") args.all = true;
    else if (arg.startsWith("--hours")) {
      const value = arg.includes("=") ? arg.split("=")[1] : undefined;
      args.hours = Number(value);
    } else if (args.hours !== undefined && Number.isNaN(args.hours)) args.hours = Number(arg);
    else args.rest.push(arg);
  }
  return args;
}

function channelRef(text: string): string | undefined {
  const match = /^<#([A-Z0-9]+)(?:\|[^>]*)?>$|^([A-Z0-9]+)$/.exec(text.trim());
  return match?.[1] ?? match?.[2];
}

// A permalink, a "channel/ts" pair, or a bare timestamp resolved through the
// database. One parser, so a link can't mean two different messages depending on
// which command read it.
async function resolveTarget(text: string): Promise<db.MessageRow | { messageId: string; channelId: string } | undefined> {
  const link = parsePermalink(text);
  if (link) return { messageId: link.ts, channelId: link.channel };

  const pair = /^([A-Z0-9]+)[/:](\d+\.\d+)$/.exec(text.trim());
  if (pair) return { messageId: pair[2], channelId: pair[1] };

  if (/^\d+\.\d+$/.test(text.trim())) return db.getMessage(text.trim());
  return undefined;
}

async function cmdStatus(): Promise<void> {
  console.log((await statusLines()).join("\n").replace(/\*/g, ""));
}

async function cmdCheck(client: WebClient, args: Args): Promise<void> {
  const channelId = channelRef(args.rest[0] ?? "");
  if (!channelId) {
    console.error("Usage: hof check <#channel|CHANNELID> [--hours=N]");
    process.exitCode = 1;
    return;
  }
  const hours = args.hours || SCAN.checkWindowHours;
  console.log(`Scanning ${channelId} for the last ${hours}h…`);
  const { candidates, threadsChecked, truncated } = await scanChannel(client, channelId, hours);
  if (candidates.length === 0) {
    console.log(`No starred messages (checked ${threadsChecked} active thread(s)).`);
  } else {
    for (const line of await explain(channelId, candidates)) console.log(line.replace(/\*/g, ""));
  }
  if (truncated) console.log("warning: the scan hit its page/thread limit, so this may be incomplete.");
}

// Everything that qualifies on the live count but has no announcement. This is
// the read-only half of what four of the old scripts did between them, and it
// checks Slack rather than trusting the stored count — which is exactly the
// column that goes stale during the downtime that creates these.
async function cmdPending(client: WebClient, args: Args): Promise<void> {
  const rows = (await db.unpostedRows()).filter((r) => !r.skip);
  const hours = args.all ? SCAN.maxMessageAgeDays * 24 : args.hours || 48;
  const cutoff = Date.now() / 1000 - hours * 3600;

  const inWindow = rows
    .filter((r) => tsSeconds(r.messageId) >= cutoff)
    .sort((a, b) => b.messageId.localeCompare(a.messageId))
    .slice(0, SCAN.maxStarChecksPerRun);

  console.log(`Checking ${inWindow.length} untracked-as-announced message(s) from the last ${hours}h against Slack…`);

  let found = 0;
  for (const row of inWindow) {
    const live = await liveStars(client, row.channelId, row.messageId);
    await delay(TIMING.slackReadDelayMs);
    if (!live.ok) {
      console.log(`  ?  ${permalinkOf(row.channelId, row.messageId)} — could not read reactions (${live.error})`);
      continue;
    }
    if (!qualifies(live.stars)) continue;
    found++;
    const ageH = Math.round((Date.now() / 1000 - tsSeconds(row.messageId)) / 3600);
    const eligible = ageH <= RULES.catchUpWindowHours ? "will be announced by the next reconcile" : `too old to auto-post (${ageH}h) — \`hof post\` to force`;
    const drift = live.stars !== row.stars ? ` (recorded ${row.stars}⭐)` : "";
    console.log(`  ${live.stars}⭐${drift} ${permalinkOf(row.channelId, row.messageId)} — ${eligible}`);
  }
  console.log(`\n${found} message(s) qualify but are not announced.`);
}

async function cmdReconcile(client: WebClient, args: Args): Promise<void> {
  if (!args.apply) console.log("Dry run — nothing will be written or posted. Pass --apply to act.\n");
  // No printing here: runReconcile streams every phase and its final summary to
  // the console as it goes (and to Slack too, when --apply turned that on).
  await runReconcile(client, { dry: !args.apply });
}

// Announces specific messages, named one at a time. This overrides the age rule
// and any skip, because naming a permalink is a deliberate act — but it still
// verifies the live star count first, so it can never post a number that isn't
// real, and it will not touch a message that already has an announcement.
async function cmdPost(client: WebClient, args: Args): Promise<void> {
  if (args.rest.length === 0) {
    console.error("Usage: hof post <permalink>… --apply");
    process.exitCode = 1;
    return;
  }
  if (args.rest.length > MAX_EXPLICIT_POSTS) {
    console.error(`Refusing to post ${args.rest.length} messages at once (limit ${MAX_EXPLICIT_POSTS}).`);
    process.exitCode = 1;
    return;
  }

  for (const text of args.rest) {
    const target = await resolveTarget(text);
    if (!target) {
      console.log(`  skip: could not resolve "${text}"`);
      continue;
    }
    const existing = await db.getMessage(target.messageId);
    if (existing?.postedMessageId) {
      console.log(`  skip: ${permalinkOf(target.channelId, target.messageId)} is already announced`);
      continue;
    }

    const live = await liveStars(client, target.channelId, target.messageId);
    await delay(TIMING.slackReadDelayMs);
    if (!live.ok) {
      console.log(`  skip: ${permalinkOf(target.channelId, target.messageId)} — could not read reactions (${live.error})`);
      continue;
    }
    if (!qualifies(live.stars)) {
      console.log(`  skip: ${permalinkOf(target.channelId, target.messageId)} has ${live.stars}⭐, below ${RULES.starThreshold}`);
      continue;
    }

    if (!args.apply) {
      console.log(`  would post: ${announcementText(live.stars, permalinkOf(target.channelId, target.messageId)).replace("\n", " ")}`);
      continue;
    }

    await db.recordStars(target.messageId, target.channelId, live.stars);
    await db.setSkip(target.messageId, false);
    const result = await postAnnouncement(client, { ...target, skip: false }, live.stars, { ignoreThrottle: true });
    console.log(result.posted ? `  posted: ${permalinkOf(target.channelId, target.messageId)}` : `  failed (${result.reason}): ${permalinkOf(target.channelId, target.messageId)}`);
    await delay(TIMING.slackPostDelayMs);
  }
  if (!args.apply) console.log("\nDry run — pass --apply to actually post.");
}

async function cmdSkip(args: Args, skip: boolean): Promise<void> {
  for (const text of args.rest) {
    const target = await resolveTarget(text);
    if (!target) {
      console.log(`  could not resolve "${text}"`);
      continue;
    }
    const changed = await db.setSkip(target.messageId, skip);
    console.log(
      changed
        ? `  ${skip ? "skipped" : "un-skipped"}: ${permalinkOf(target.channelId, target.messageId)}`
        : `  not tracked: ${permalinkOf(target.channelId, target.messageId)}`
    );
  }
}

const USAGE = `hof <command>

  status                            counts, last reconcile, and the rules in force
  check <#channel> [--hours=N]      what is starred in a channel right now, and why
  pending [--hours=N|--all]         messages that qualify on the live count but aren't announced
  reconcile [--apply]               fix drifted counts and post what was missed (dry run by default)
  post <permalink>… [--apply]       announce specific messages, overriding the age rule and any skip
  skip <permalink>…                 never announce these
  unskip <permalink>…               allow announcing these again
  migrate                           create or upgrade the database schema
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const localOnly = ["status", "skip", "unskip", "migrate"];
  const needsSlack = !localOnly.includes(args.verb);
  requireEnv(needsSlack ? ["SLACK_BOLT_TOKEN", "DATABASE_URL"] : ["DATABASE_URL"]);

  const client = new WebClient(process.env.SLACK_BOLT_TOKEN);
  // Only commands that actually change #hall-of-fame log to the team's channel.
  // A read-only run stays entirely local.
  if (args.apply && (args.verb === "reconcile" || args.verb === "post")) log.init(client);

  // The CLI deliberately does NOT create or migrate the schema — the app does
  // that at boot. A read-only command that quietly runs ALTER TABLE against the
  // production database is a trap, and `hof help` running one is how this
  // sentence came to be written.
  try {
    switch (args.verb) {
    case "migrate":
      // The one command that may change the schema, and it says so in its name.
      // Everything else assumes the app has already done it at boot, so a
      // read-only command can never quietly run ALTER TABLE.
      await db.initSchema();
      console.log("Schema is up to date.");
      break;
    case "status":
      await cmdStatus();
      break;
    case "check":
      await cmdCheck(client, args);
      break;
    case "pending":
      await cmdPending(client, args);
      break;
    case "reconcile":
      await cmdReconcile(client, args);
      break;
    case "post":
      await cmdPost(client, args);
      break;
    case "skip":
      await cmdSkip(args, true);
      break;
    case "unskip":
      await cmdSkip(args, false);
      break;
    default:
      console.log(USAGE);
      process.exitCode = args.verb === "help" || args.verb === "--help" ? 0 : 1;
    }
  } finally {
    await log.flush();
    await db.closeDb();
  }
}

main().catch((err) => {
  // 42703 undefined_column / 42P01 undefined_table mean the schema is older than
  // this build. Since the CLI deliberately never migrates on its own, that needs
  // saying in one line rather than as a Postgres stack trace.
  const code = (err as { code?: string })?.code;
  if (code === "42703" || code === "42P01") {
    console.error(
      `The database schema is out of date (${(err as Error).message}).\n` +
        "Run `yarn hof migrate` — or just deploy, since the app migrates at boot."
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});
