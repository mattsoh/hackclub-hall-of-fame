// Checks every DB row that was never announced (postedMessageId is empty)
// against its LIVE star reaction count in Slack. The DB's stars column can
// drift from reality (missed reaction_added/removed events, downtime, etc) —
// Slack is the source of truth. This is read-only: it never writes to the DB
// or posts anything.
//
// Usage: node scripts/checkUnpostedStars.js
// Requires SLACK_BOLT_TOKEN and DATABASE_URL in .env.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { WebClient } = require("@slack/web-api");
const { Client } = require("pg");

const OUTPUT_DIR = path.join(__dirname, "output");
const CALL_DELAY_MS = 200;

function writeCsv(filename, rows, columns) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const filePath = path.join(OUTPUT_DIR, filename);
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => `"${String(row[c] ?? "").replace(/"/g, '""')}"`).join(","));
  }
  fs.writeFileSync(filePath, lines.join("\n"));
  return filePath;
}

async function getStarCount(client, channel, ts) {
  try {
    const res = await client.reactions.get({ channel, timestamp: ts });
    const star = (res.message.reactions || []).find((r) => r.name === "star");
    return { ok: true, stars: star ? star.count : 0 };
  } catch (err) {
    return { ok: false, error: (err.data && err.data.error) || err.message };
  }
}

async function main() {
  console.log("Starting live-star check...");

  const slackClient = new WebClient(process.env.SLACK_BOLT_TOKEN);

  const dbUrl = new URL(process.env.DATABASE_URL);
  dbUrl.search = "";
  const db = new Client({ connectionString: dbUrl.toString(), ssl: { rejectUnauthorized: true } });

  console.log("[db] connecting...");
  await db.connect();
  console.log("[db] connected");

  try {
    console.log("[db] querying unposted rows...");
    const res = await db.query(
      `SELECT "messageId", "channelId", stars
       FROM "Message"
       WHERE "postedMessageId" IS NULL OR "postedMessageId" = ''
       ORDER BY stars DESC`
    );
    const rows = res.rows;
    console.log(`[db] ${rows.length} unposted rows to check\n`);

    const drifted = [];
    const nowAtThreshold = [];
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const result = await getStarCount(slackClient, row.channelId, row.messageId);

      if (!result.ok) {
        errors.push({ ...row, error: result.error });
      } else if (result.stars !== row.stars) {
        const entry = { ...row, dbStars: row.stars, liveStars: result.stars };
        drifted.push(entry);
        if (result.stars >= 5) nowAtThreshold.push(entry);
      }

      if ((i + 1) % 50 === 0 || i === rows.length - 1) {
        console.log(`[check] ${i + 1}/${rows.length} checked, ${drifted.length} drifted so far, ${nowAtThreshold.length} now at/above threshold`);
      }

      await new Promise((resolve) => setTimeout(resolve, CALL_DELAY_MS));
    }

    console.log("\n=== Results ===");
    console.log(`Checked: ${rows.length}`);
    console.log(`Drifted (live != db): ${drifted.length}`);
    console.log(`Now at/above 5 stars but never posted: ${nowAtThreshold.length}`);
    console.log(`Lookup errors (deleted msg/channel access/etc): ${errors.length}`);

    if (nowAtThreshold.length) {
      console.log(`\nShould have been posted (sorted by live stars):`);
      for (const e of [...nowAtThreshold].sort((a, b) => b.liveStars - a.liveStars)) {
        const link = `https://hackclub.slack.com/archives/${e.channelId}/p${e.messageId.replace(".", "")}`;
        console.log(`  db=${e.dbStars} live=${e.liveStars}  ${link}`);
      }
    }

    if (drifted.length) {
      const file = writeCsv("drifted-unposted.csv", drifted, ["messageId", "channelId", "dbStars", "liveStars"]);
      console.log(`\nFull drifted list (${drifted.length} rows) written to ${file}`);
    }

    if (errors.length) {
      const file = writeCsv("unposted-lookup-errors.csv", errors, ["messageId", "channelId", "stars", "error"]);
      console.log(`Lookup errors (${errors.length} rows) written to ${file}`);
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
