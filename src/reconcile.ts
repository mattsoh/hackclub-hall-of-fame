// Keeps #hall-of-fame accurate: fixes star counts that drifted, records
// announcements the database lost track of, notices announcements a human
// deleted, and posts the few things the bot genuinely missed.
//
// The rule that makes this safe to run automatically — and the reason a restart
// can no longer spam the channel — is that it only posts an origin younger than
// RULES.catchUpWindowHours, and deals with at most RULES.maxCatchUpPostsPerRun
// messages per run. Everything older that qualifies is
// recorded with its true star count and left alone. That decision is re-derived
// from each message's timestamp every run, so unlike the `announce = false` flag
// it replaces, it cannot be written down wrongly and cannot permanently retire
// a message that later earns stars organically.

import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import * as db from "./db";
import { BOT_NAME, CHANNELS, LOGGING, RULES, SCAN, TIMING } from "./config";
import { log, RunLog } from "./log";
import {
  ANNOUNCEMENT_STARS,
  delay,
  fetchHistory,
  liveStars,
  parsePermalink,
  permalinkOf,
  tsSeconds,
} from "./slack";
import { postAnnouncement, qualifies, updateAnnouncement, withinCatchUpWindow } from "./policy";

interface Announcement {
  ts: string;
  stars: number;
  botId?: string;
  originChannel?: string;
  originTs?: string;
}

export interface ReconcileSummary {
  lines: string[];
  details: string[];
  changed: boolean;
}

// A run can take tens of minutes. Guarded in-process so a slow run overrunning
// its interval can't put two scans on the same data at once.
let running = false;

export function isRunning(): boolean {
  return running;
}

// The bot_id the current token posts under. Announcements from an earlier
// installation of the app carry a different one and cannot be edited with this
// token — Slack rejects those chat.update calls as cant_update_message.
async function ownBotId(client: WebClient): Promise<string | undefined> {
  try {
    const res = await client.auth.test();
    return typeof res.bot_id === "string" ? res.bot_id : undefined;
  } catch (err) {
    log.warn("Could not resolve own bot_id — assuming all announcements are editable", err);
    return undefined;
  }
}

async function readHallOfFame(client: WebClient): Promise<{
  announcements: Announcement[];
  truncated: boolean;
  unparseable: number;
}> {
  const { messages, truncated } = await fetchHistory(client, CHANNELS.hallOfFame, {
    maxPages: SCAN.maxHistoryPages,
  });

  const announcements: Announcement[] = [];
  let unparseable = 0;

  for (const message of messages) {
    if (!message.bot_id) continue;
    // bot_profile is absent on some older messages. Treating that as "not ours"
    // dropped real announcements from the set, which then looked deleted from
    // Slack on every single run — so a missing profile falls back to the
    // star-line format check alone.
    if (message.bot_profile && message.bot_profile.name !== BOT_NAME) continue;
    const match = ANNOUNCEMENT_STARS.exec(message.text || "");
    if (!match) continue;

    const origin = parsePermalink(message.text);
    if (!origin) {
      // An announcement whose permalink can't be read can't be tied to an
      // origin, so it can't be reconciled. Counted and reported rather than
      // silently folded into another number.
      unparseable++;
      continue;
    }
    announcements.push({
      ts: message.ts,
      stars: Number(match[1]),
      botId: message.bot_id as string,
      originChannel: origin.channel,
      originTs: origin.ts,
    });
  }

  return { announcements, truncated, unparseable };
}

interface Selection {
  toCheck: db.MessageRow[];
  nextCursor: string;
  recentSkipped: number;
  olderTotal: number;
  tooOld: number;
}

// Everything from the last SCAN.alwaysRecheckDays, plus as much of the rest of
// the year-long window as the per-run budget allows, resuming where the last run
// stopped so the whole window is covered across successive runs.
//
// The cap applies to the whole phase. The old version capped only the older
// slice, so the number that was supposed to bound a run's API usage didn't.
function selectToCheck(rows: db.MessageRow[], cursor: string): Selection {
  const now = Date.now() / 1000;
  const recentCutoff = now - SCAN.alwaysRecheckDays * 86400;
  const ageCutoff = now - SCAN.maxMessageAgeDays * 86400;

  const inWindow = rows.filter((r) => tsSeconds(r.messageId) >= ageCutoff);
  // Slack timestamps are fixed-width, so string order is chronological order.
  // Comparing on the full ts rather than truncated seconds means rows sharing a
  // second with the cursor are no longer skipped.
  const recent = inWindow
    .filter((r) => tsSeconds(r.messageId) >= recentCutoff)
    .sort((a, b) => b.messageId.localeCompare(a.messageId));
  const older = inWindow
    .filter((r) => tsSeconds(r.messageId) < recentCutoff)
    .sort((a, b) => a.messageId.localeCompare(b.messageId));

  const recentSlice = recent.slice(0, SCAN.maxStarChecksPerRun);
  const budget = SCAN.maxStarChecksPerRun - recentSlice.length;

  const resumeAt = older.findIndex((r) => r.messageId > cursor);
  const rotated = resumeAt === -1 ? older : [...older.slice(resumeAt), ...older.slice(0, resumeAt)];
  const olderSlice = rotated.slice(0, budget);

  return {
    toCheck: [...recentSlice, ...olderSlice],
    nextCursor: olderSlice.length > 0 ? olderSlice[olderSlice.length - 1].messageId : cursor,
    recentSkipped: recent.length - recentSlice.length,
    olderTotal: older.length,
    tooOld: rows.length - inWindow.length,
  };
}

async function reconcileBody(client: WebClient, dry: boolean, run: RunLog): Promise<ReconcileSummary> {
  const startedAt = Date.now();
  const lines: string[] = [];
  const details: string[] = [];
  const warnings: string[] = [];

  const botId = await ownBotId(client);
  run.step(`reading #hall-of-fame history (up to ${SCAN.maxHistoryPages} pages)…`);
  const { announcements, truncated, unparseable } = await readHallOfFame(client);
  run.step(`found ${announcements.length} announcements in the channel`);

  if (truncated) {
    // Without the full channel, "this announcement isn't in Slack" is not a
    // conclusion that can be drawn — so the phases that depend on it are
    // skipped rather than acting on a partial picture.
    warnings.push(
      `#hall-of-fame history was truncated at ${SCAN.maxHistoryPages} pages — backfill and deleted-announcement ` +
        "detection were skipped this run."
    );
  }
  if (unparseable > 0) {
    warnings.push(`${unparseable} announcement(s) have an unreadable permalink and can't be reconciled.`);
  }

  const posted = await db.postedRows();
  const unposted = await db.unpostedRows();
  const postedByAnnouncementTs = new Map(posted.map((r) => [r.postedMessageId as string, r]));
  const trackedOrigins = new Set(posted.map((r) => r.messageId));
  run.step(`database has ${posted.length} announced and ${unposted.length} unannounced message(s)`);

  // ---- Record announcements the database has no row for -------------------
  // These are already in the channel. Recording them is what stops the
  // reconciler treating them as never-announced and posting a second copy —
  // historically the largest source of the channel's 362 duplicates. Deduped by
  // origin, keeping the highest count where the same origin was announced more
  // than once.
  let recorded = 0;
  let duplicates = 0;
  if (!truncated) {
    const byOrigin = new Map<string, Announcement>();
    let untracked = 0;
    for (const a of announcements) {
      if (postedByAnnouncementTs.has(a.ts)) continue;
      // Its origin is already recorded as announced, so this is a second copy.
      // A row holds one postedMessageId, so only one copy can ever be tracked.
      if (a.originTs && trackedOrigins.has(a.originTs)) {
        duplicates++;
        continue;
      }
      untracked++;
      const key = `${a.originChannel}:${a.originTs}`;
      const existing = byOrigin.get(key);
      if (!existing || a.stars > existing.stars) byOrigin.set(key, a);
    }
    // Counted by difference rather than incremented in the else branch, which
    // missed the case where a later copy replaced an earlier one.
    duplicates += untracked - byOrigin.size;

    for (const a of byOrigin.values()) {
      if (!dry) await db.recordAnnounced(a.originTs as string, a.originChannel as string, a.stars, a.ts);
      recorded++;
    }
    run.step(
      recorded > 0
        ? `recorded ${recorded} announcement(s) the database had lost` +
          (duplicates > 0 ? `, and counted ${duplicates} duplicate(s) in the channel` : "")
        : "no untracked announcements to record"
    );
  }

  // ---- Announcements a human deleted --------------------------------------
  // The bot's own deletions clear the link as they go, so a recorded
  // announcement that isn't in the channel was removed by a person. Skip is set
  // so the next star on that message doesn't quietly undo the moderation.
  const announcementTsSet = new Set(announcements.map((a) => a.ts));
  const announcementByOrigin = new Map(announcements.filter((a) => a.originTs).map((a) => [a.originTs as string, a]));
  let humanDeleted = 0;
  let repointed = 0;
  if (!truncated) {
    for (const row of posted) {
      if (announcementTsSet.has(row.postedMessageId as string)) continue;

      // The copy this row points at is gone, but another announcement for the
      // same origin is still in the channel — the channel holds 363 duplicates,
      // so deleting one of a pair is common. The message is still in the hall of
      // fame, so nothing was moderated away: re-point at the survivor instead of
      // calling it deleted.
      //
      // Getting this wrong doesn't just mislabel it. Clearing the link here would
      // undo the backfill phase above, which had just recorded that survivor, and
      // the next run would record it again — the exact postedMessageId
      // oscillation the old sync job suffered, where each run swapped the link
      // between two copies of the same announcement in perpetuity.
      const survivor = announcementByOrigin.get(row.messageId);
      if (survivor) {
        if (!dry) await db.recordAnnounced(row.messageId, row.channelId, survivor.stars, survivor.ts);
        repointed++;
        continue;
      }

      if (!dry) {
        await db.clearPosted(row.messageId);
        await db.setSkip(row.messageId, true);
      }
      humanDeleted++;
      if (details.length < 200) {
        details.push(`removed by hand: ${permalinkOf(row.channelId, row.messageId)}`);
      }
    }
    run.step(
      (humanDeleted > 0
        ? `${humanDeleted} announcement(s) were deleted by hand — clearing their links and marking them skipped`
        : "no announcements were deleted by hand") +
        (repointed > 0 ? `; ${repointed} re-pointed at a surviving duplicate` : "")
    );
  }

  // ---- Live star check ---------------------------------------------------
  const state = await db.getState();
  const selection = selectToCheck([...posted, ...unposted], state.scanCursor ?? "");

  // A floor, not an estimate: measured runs come in around 1.5x this, because
  // some calls still hit a 429 and wait out the WebClient's own retry on top of
  // our pacing. 800 checks paced at 1250ms predicts 17 min and took 24.
  const atLeastMinutes = Math.round((selection.toCheck.length * TIMING.slackReadDelayMs) / 60000);
  run.step(
    `checking live star counts on ${selection.toCheck.length} message(s) — everything from the last ` +
      `${SCAN.alwaysRecheckDays} days plus a rotating slice of the ${selection.olderTotal} older ones. ` +
      `This is the slow part: at least ${atLeastMinutes} min, usually nearer ${Math.round(atLeastMinutes * 1.5)}.`
  );

  // Only counts confirmed against Slack in this run are allowed to trigger a
  // post, so nothing is ever announced on the strength of a stale cached number.
  const verified = new Map<string, number>();
  let corrected = 0;
  let updated = 0;
  let uneditable = 0;
  let lookupErrors = 0;
  const errorReasons = new Map<string, number>();
  let checked = 0;

  for (const row of selection.toCheck) {
    const result = await liveStars(client, row.channelId, row.messageId);
    checked++;
    await delay(TIMING.slackReadDelayMs);

    // The cursor is persisted as the scan proceeds, so a run that dies partway
    // through keeps its rotation progress instead of discarding all of it.
    if (checked % LOGGING.starCheckReportEvery === 0) {
      if (!dry) await db.setScanCursor(row.messageId);
      run.step(
        `checked ${checked}/${selection.toCheck.length} — ${corrected} count(s) corrected, ` +
          `${updated} announcement(s) updated, ${lookupErrors} lookup error(s)`
      );
    }

    if (!result.ok) {
      lookupErrors++;
      const reason = result.error ?? "unknown";
      errorReasons.set(reason, (errorReasons.get(reason) ?? 0) + 1);
      continue;
    }

    verified.set(row.messageId, result.stars);
    if (result.stars === row.stars) continue;

    if (!dry) await db.setStars(row.messageId, result.stars);
    corrected++;

    if (!row.postedMessageId) continue;

    const announcement = announcementByOrigin.get(row.messageId);
    // Posted by a previous installation of the app: Slack will not let this
    // token edit it, so its displayed count is frozen for good. The database is
    // corrected and it's reported once, rather than failing on every run.
    if (botId && announcement?.botId && announcement.botId !== botId) {
      uneditable++;
      continue;
    }
    if (dry) continue;

    const outcome = await updateAnnouncement(client, row, result.stars);
    if (outcome === "updated") updated++;
    await delay(TIMING.slackPostDelayMs);
  }

  if (!dry) await db.setScanCursor(selection.nextCursor);
  run.step(
    `finished the star check: ${checked} checked, ${corrected} corrected, ${updated} announcement(s) updated, ` +
      `${uneditable} un-editable, ${lookupErrors} lookup error(s)`
  );

  // ---- Post what was genuinely missed ------------------------------------
  const candidates = unposted
    .filter((row) => !row.skip)
    .map((row) => ({ row, stars: verified.get(row.messageId) }))
    .filter((c): c is { row: db.MessageRow; stars: number } => c.stars !== undefined && qualifies(c.stars));

  const fresh = candidates.filter((c) => withinCatchUpWindow(c.row.messageId));
  const stale = candidates.length - fresh.length;

  // Oldest first, so the channel reads chronologically.
  fresh.sort((a, b) => a.row.messageId.localeCompare(b.row.messageId));

  run.step(
    `${candidates.length} message(s) qualify but aren't announced: ${fresh.length} inside the ` +
      `${RULES.catchUpWindowHours}h catch-up window` +
      (stale > 0 ? `, ${stale} older than it (recorded, not posted)` : "") +
      (fresh.length > RULES.maxCatchUpPostsPerRun ? ` — capped at ${RULES.maxCatchUpPostsPerRun} this run` : "")
  );

  let announced = 0;
  let queued = 0;
  let deferred = 0;
  for (const candidate of fresh) {
    const link = permalinkOf(candidate.row.channelId, candidate.row.messageId);
    // The per-run ceiling counts posts and approval requests together: both cost
    // a human's attention, and a large backlog shouldn't become a large pile of
    // buttons. The remainder is left untouched and is eligible again next run.
    if (announced + queued >= RULES.maxCatchUpPostsPerRun) {
      deferred = fresh.length - announced - queued;
      break;
    }
    if (dry) {
      details.push(`would post or queue: ${candidate.stars}⭐ ${link}`);
      announced++;
      continue;
    }
    const result = await postAnnouncement(client, candidate.row, candidate.stars);
    if (result.posted) {
      announced++;
      details.push(`announced: ${candidate.stars}⭐ ${link}`);
      await delay(TIMING.slackPostDelayMs);
    } else if (result.reason === "queued") {
      queued++;
      details.push(`queued for approval: ${candidate.stars}⭐ ${link}`);
    }
  }

  // ---- Summary -----------------------------------------------------------
  const minutes = Math.round((Date.now() - startedAt) / 60000);
  const changed =
    recorded > 0 ||
    humanDeleted > 0 ||
    repointed > 0 ||
    corrected > 0 ||
    announced > 0 ||
    queued > 0 ||
    lookupErrors > 0 ||
    warnings.length > 0;

  lines.push(`*Reconcile*${dry ? " (dry run — nothing was written or posted)" : ""} — ${minutes} min`);
  lines.push(`• announcements in channel: ${announcements.length}, tracked messages: ${posted.length + unposted.length}`);
  lines.push(
    `• star counts checked: ${checked} of ${posted.length + unposted.length} · corrected: ${corrected} · ` +
      `announcements updated: ${updated}`
  );
  if (recorded > 0) lines.push(`• recorded announcements the database had lost: ${recorded}`);
  if (duplicates > 0) lines.push(`• duplicate announcements in the channel (same origin announced twice): ${duplicates}`);
  if (humanDeleted > 0) lines.push(`• announcements deleted by hand (now skipped, won't be reposted): ${humanDeleted}`);
  if (repointed > 0) lines.push(`• re-pointed at a surviving duplicate announcement: ${repointed}`);
  if (uneditable > 0) {
    lines.push(`• un-editable (posted by an earlier install of this app; database corrected, channel text stays stale): ${uneditable}`);
  }
  if (announced > 0) lines.push(`• announced now: ${announced} — see thread`);
  if (stale > 0) {
    lines.push(
      `• qualify but older than ${RULES.catchUpWindowHours}h, so not auto-posted: ${stale} ` +
        "(recorded with the right count; `hof post <link>` to announce one deliberately)"
    );
  }
  if (queued > 0) lines.push(`• queued for approval here (over a pace limit): ${queued} — see thread`);
  if (deferred > 0) lines.push(`• left for the next run (over the ${RULES.maxCatchUpPostsPerRun}-per-run ceiling): ${deferred}`);
  if (lookupErrors > 0) {
    const breakdown = [...errorReasons.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}: ${n}`).join(", ");
    lines.push(`• star lookups that failed: ${lookupErrors} (${breakdown})`);
  }
  if (selection.recentSkipped > 0) {
    lines.push(`• recent messages not reached within the ${SCAN.maxStarChecksPerRun}-check budget: ${selection.recentSkipped}`);
  }
  if (selection.tooOld > 0) {
    lines.push(`• older than ${SCAN.maxMessageAgeDays} days, not checked: ${selection.tooOld}`);
  }
  for (const warning of warnings) lines.push(`• :warning: ${warning}`);
  if (!changed) lines.push("• nothing needed changing");

  return { lines, details, changed };
}

// Runs a reconcile and reports it. Every phase streams into the thread of a
// single channel message, which is then rewritten into the summary — so a run
// that takes tens of minutes is visibly progressing the whole time, and the
// channel still only gains one message per run.
export async function runReconcile(
  client: WebClient,
  opts: { dry?: boolean } = {}
): Promise<ReconcileSummary> {
  const dry = Boolean(opts.dry);
  const run = log.startRun(dry ? "Reconcile (dry run)" : "Reconcile");
  const startedAt = Date.now();
  try {
    const summary = await reconcileBody(client, dry, run);
    await run.finish(summary.lines.join("\n"), summary.details);
    return summary;
  } catch (err) {
    // The run message must reach a terminal state either way, or the channel is
    // left showing "running…" for a job that died half an hour ago.
    const minutes = Math.round((Date.now() - startedAt) / 60000);
    await run.finish(`:rotating_light: *Reconcile failed* after ${minutes} min — see the error in this channel.`);
    throw err;
  }
}

// Entry point used by the timer and the slash command.
export async function reconcile(app: App, opts: { dry?: boolean } = {}): Promise<void> {
  if (running) {
    log.info("Reconcile: a run is already in progress, skipping this one.");
    return;
  }
  running = true;
  try {
    await runReconcile(app.client, opts);
    if (!opts.dry) await db.markReconciled();
  } catch (err) {
    log.error("Reconcile failed", err);
  } finally {
    running = false;
  }
}

// True when enough time has passed since the last completed run. Checked on boot
// so a restart — production once saw 12 in 4 hours — doesn't trigger a scan
// every time, which is the behaviour that made startup sync unusable.
export async function dueForRun(): Promise<boolean> {
  const { lastReconcileAt } = await db.getState();
  if (!lastReconcileAt) return true;
  return Date.now() - new Date(lastReconcileAt).getTime() >= TIMING.reconcileIntervalMs;
}
