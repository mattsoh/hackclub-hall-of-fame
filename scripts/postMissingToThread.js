// Posts hall-of-fame entries that were NEVER announced (drifted-unposted.csv,
// filtered to live stars >= 5) for a given year (default 2026), as replies
// under a thread you create yourself. These are genuine first-time posts —
// no announcement exists anywhere in #hall-of-fame for them yet.
//
// The DB rows for these already exist and are marked announce=false (from
// backfillDb.js). After a successful post (--apply only), this script
// (re)sets announce=false on that row too, as a belt-and-suspenders guarantee
// that posting here can never make it eligible for a real auto-send later.
//
// Usage:
//   node scripts/postMissingToThread.js <thread-permalink> [--year=2026] [--apply]
//
// <thread-permalink> is the Slack permalink of the message you want replies
// threaded under (copy it via "Copy link" in Slack). By default this is a DRY
// RUN that only prints what would be posted — pass --apply to actually send
// (and to update the DB's announce flag).
//
// Requires SLACK_BOLT_TOKEN and DATABASE_URL in .env, and
// scripts/output/drifted-unposted.csv (generate/refresh it first with
// `node scripts/diffNinjaHistory.js`).

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { WebClient } = require("@slack/web-api");
const { Client } = require("pg");

const OUTPUT_DIR = path.join(__dirname, "output");
const DRIFTED_CSV = path.join(OUTPUT_DIR, "drifted-unposted.csv");
const POST_DELAY_MS = 1200;

function parseArgs(argv) {
  const args = { permalink: null, year: 2026, apply: false };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg.startsWith("--year=")) args.year = Number(arg.slice("--year=".length));
    else if (!arg.startsWith("--")) args.permalink = arg;
  }
  return args;
}

function parseThreadLink(permalink) {
  const url = new URL(permalink);
  const match = /\/archives\/([A-Z0-9]+)\/p(\d+)/.exec(url.pathname);
  if (!match) throw new Error(`Could not parse channel/ts from permalink: ${permalink}`);
  const [, channel, raw] = match;
  const ts = raw.length > 6 ? `${raw.slice(0, -6)}.${raw.slice(-6)}` : raw;
  const threadTs = url.searchParams.get("thread_ts") || ts;
  return { channel, threadTs };
}

function parseCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const [header, ...lines] = fs.readFileSync(filePath, "utf8").trim().split("\n");
  const columns = header.split(",");
  return lines
    .filter(Boolean)
    .map((line) => {
      const values = line.slice(1, -1).split('","');
      const row = {};
      columns.forEach((col, i) => (row[col] = values[i]));
      return row;
    });
}

function originLink(channel, ts) {
  return `https://hackclub.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
}

function loadCandidates(year) {
  const rows = parseCsv(DRIFTED_CSV).filter(
    (r) => Number(r.liveStars) >= 5 && new Date(Number(r.messageId) * 1000).getUTCFullYear() === year
  );
  return rows
    .map((r) => ({
      date: r.date,
      stars: Number(r.liveStars),
      messageId: r.messageId,
      channelId: r.channelId,
    }))
    .sort((a, b) => Number(a.messageId) - Number(b.messageId));
}

async function main() {
  const { permalink, year, apply } = parseArgs(process.argv.slice(2));
  if (!permalink) {
    console.error("Usage: node scripts/postMissingToThread.js <thread-permalink> [--year=2026] [--apply]");
    process.exit(1);
  }

  const { channel, threadTs } = parseThreadLink(permalink);
  console.log(`Thread: channel=${channel} thread_ts=${threadTs}`);

  const rows = loadCandidates(year);
  console.log(`${rows.length} never-posted-but-qualifying entries for ${year} (from drifted-unposted.csv)\n`);

  if (!rows.length) return;

  for (const row of rows) {
    const link = originLink(row.channelId, row.messageId);
    console.log(`${apply ? "[posting]" : "[dry-run]"} ${row.date}  ${row.stars}⭐  ${link}`);
  }

  if (!apply) {
    console.log("\nDry run only — nothing was posted, and the DB was not touched. Re-run with --apply to actually post these to the thread.");
    return;
  }

  const slackClient = new WebClient(process.env.SLACK_BOLT_TOKEN);

  const dbUrl = new URL(process.env.DATABASE_URL);
  dbUrl.search = "";
  const db = new Client({ connectionString: dbUrl.toString(), ssl: { rejectUnauthorized: true } });
  console.log("\n[db] connecting...");
  await db.connect();
  console.log("[db] connected\n");

  try {
    for (const row of rows) {
      const link = originLink(row.channelId, row.messageId);
      const text = `⭐ *${row.stars}*\n${link}`;
      await slackClient.chat.postMessage({ channel, thread_ts: threadTs, text });

      const result = await db.query(`UPDATE "Message" SET announce = false WHERE "messageId" = $1`, [row.messageId]);
      const dbNote = result.rowCount === 0 ? " (WARNING: no matching DB row — run backfillDb.js --apply first)" : " (announce=false set)";

      console.log(`posted: ${row.date} ${row.stars}⭐${dbNote}`);
      await new Promise((resolve) => setTimeout(resolve, POST_DELAY_MS));
    }

    console.log(`\nDone — posted ${rows.length} message(s) to the thread.`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
