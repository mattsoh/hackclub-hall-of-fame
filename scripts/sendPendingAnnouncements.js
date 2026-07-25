// Sends the hall-of-fame announcement for DB rows that qualify AND haven't
// already been handled some other way. A row is eligible only if ALL of:
//   - announce = true          (not already surfaced via postMissingToThread.js)
//   - stars >= 5                (actually crosses the hall-of-fame threshold)
//   - postedMessageId is empty  (genuinely never posted — belt and suspenders
//                                alongside `announce`, since a bulk backfill
//                                should never be able to trigger a re-send)
// Anything not matching all three is never touched, never sent.
//
// This is the sole place a backfill can result in an actual Slack post, kept
// deliberately separate from backfillDb.js so that a bulk DB write can never
// accidentally turn into a burst of messages.
//
// For each row sent: posts "⭐ *N*\n<permalink>" (matching the bot's normal
// format), records the resulting message ts as postedMessageId, and sets
// announce = false.
//
// Usage: node scripts/sendPendingAnnouncements.js [--apply] [--limit=N]
// Default is a DRY RUN — prints what would be sent, sends nothing.
// Requires SLACK_BOLT_TOKEN and DATABASE_URL in .env.

require("dotenv").config();
const { WebClient } = require("@slack/web-api");
const { Client } = require("pg");

const POST_DELAY_MS = 1200;

function parseArgs(argv) {
  const args = { apply: false, limit: Infinity };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg.startsWith("--limit=")) args.limit = Number(arg.slice("--limit=".length));
  }
  return args;
}

function originLink(channel, ts) {
  return `https://hackclub.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
}

async function main() {
  const { apply, limit } = parseArgs(process.argv.slice(2));

  const dbUrl = new URL(process.env.DATABASE_URL);
  dbUrl.search = "";
  const db = new Client({ connectionString: dbUrl.toString(), ssl: { rejectUnauthorized: true } });

  console.log("[db] connecting...");
  await db.connect();
  console.log("[db] connected");

  try {
    const res = await db.query(
      `SELECT "messageId", "channelId", stars FROM "Message"
       WHERE announce = true
         AND stars >= 5
         AND ("postedMessageId" IS NULL OR "postedMessageId" = '')
       ORDER BY "messageId" ASC`
    );
    const rows = res.rows.slice(0, limit);
    console.log(`[db] ${res.rows.length} row(s) eligible (announce=true, stars>=5, unposted)` + (limit < Infinity ? ` (processing first ${rows.length} due to --limit)` : "") + "\n");

    if (!rows.length) return;

    for (const row of rows) {
      console.log(`${apply ? "[sending]" : "[dry-run]"} ${row.stars}⭐  ${originLink(row.channelId, row.messageId)}`);
    }

    if (!apply) {
      console.log("\nDry run only — nothing was sent. Re-run with --apply to actually post these.");
      return;
    }

    const client = new WebClient(process.env.SLACK_BOLT_TOKEN);
    let sent = 0;
    for (const row of rows) {
      const link = originLink(row.channelId, row.messageId);
      const text = `⭐ *${row.stars}*\n${link}`;
      const posted = await client.chat.postMessage({ channel: "C028VGT0JMQ", text });

      await db.query(
        `UPDATE "Message" SET "postedMessageId" = $2, announce = false WHERE "messageId" = $1`,
        [row.messageId, posted.ts]
      );

      sent++;
      console.log(`sent (${sent}/${rows.length}): ${row.stars}⭐ -> postedMessageId=${posted.ts}`);
      await new Promise((resolve) => setTimeout(resolve, POST_DELAY_MS));
    }

    console.log(`\nDone — sent ${sent} announcement(s).`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
