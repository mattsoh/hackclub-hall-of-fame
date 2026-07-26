// Re-posts announcements that are recorded in the DB as sent but are no
// longer present in #hall-of-fame — i.e. the announcement was deleted after
// the fact.
//
// sendPendingAnnouncements.js deliberately cannot do this: it requires
// postedMessageId to be empty, so a row whose announcement was deleted looks
// permanently handled and is skipped forever. This script inverts that test —
// it asks whether an announcement for the origin is *currently in the
// channel*, read off the permalinks announcements embed, rather than trusting
// the column.
//
// Eligibility, all of which must hold:
//   - live star count from Slack >= 5   (not the DB's cached column)
//   - no announcement for that origin currently in #hall-of-fame
//   - the origin message still exists and is readable
//
// On send: posts "⭐ *N*\n<permalink>" with the LIVE count, repoints
// postedMessageId at the new announcement, and sets announce = false to match
// sendPendingAnnouncements.js.
//
// Usage: node scripts/repostMissingToHallOfFame.js [--hours N | --all] [--apply]
// Default is a DRY RUN — prints what would be sent, sends nothing.
// Requires SLACK_BOLT_TOKEN and DATABASE_URL in .env.

require("dotenv").config();
const { WebClient } = require("@slack/web-api");
const { Client } = require("pg");

const HALL_OF_FAME_CHANNEL = "C028VGT0JMQ";
const STAR_THRESHOLD = 5;
const CALL_DELAY_MS = 1250;
const POST_DELAY_MS = 1200;
const ANNOUNCED_LOOKBACK_DAYS = 90;
const PERMALINK = /archives\/([A-Z0-9]+)\/p(\d+)/;

function parseArgs(argv) {
  const all = argv.includes("--all");
  const apply = argv.includes("--apply");
  const hoursIndex = argv.indexOf("--hours");
  const hours = hoursIndex !== -1 ? Number(argv[hoursIndex + 1]) : 24;
  if (!all && (!Number.isFinite(hours) || hours <= 0)) {
    throw new Error("--hours needs a positive number");
  }
  return { all, apply, hours };
}

function originLink(channel, ts) {
  return `https://hackclub.slack.com/archives/${channel}/p${String(ts).replace(".", "")}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mirrors starCountFromMessage in src/utils/stars.ts — an author's own star
// must not push their message over the threshold.
function starCountFromMessage(message) {
  const star = (message?.reactions ?? []).find((r) => r.name === "star");
  if (!star) return 0;
  const author = message.user;
  const authorStarred = Boolean(author) && Array.isArray(star.users) && star.users.includes(author);
  return Math.max(0, star.count - (authorStarred ? 1 : 0));
}

async function liveStarCount(slack, channel, ts) {
  try {
    const res = await slack.reactions.get({ channel, timestamp: ts });
    return { ok: true, stars: starCountFromMessage(res.message) };
  } catch (err) {
    return { ok: false, error: (err.data && err.data.error) || err.message };
  }
}

async function fetchAnnouncedOrigins(slack) {
  const announced = new Set();
  const oldest = String(Math.floor(Date.now() / 1000) - ANNOUNCED_LOOKBACK_DAYS * 86400);
  let cursor;
  let pages = 0;
  do {
    const res = await slack.conversations.history({
      channel: HALL_OF_FAME_CHANNEL,
      oldest,
      limit: 200,
      cursor,
    });
    for (const message of res.messages ?? []) {
      const match = PERMALINK.exec(message.text ?? "");
      if (!match) continue;
      const digits = match[2];
      announced.add(`${match[1]}/${digits.slice(0, 10)}.${digits.slice(10)}`);
    }
    cursor = res.response_metadata?.next_cursor;
    pages++;
    if (cursor) await delay(CALL_DELAY_MS);
  } while (cursor && pages < 60);
  return announced;
}

async function main() {
  const { all, apply, hours } = parseArgs(process.argv.slice(2));
  const slack = new WebClient(process.env.SLACK_BOLT_TOKEN);

  console.log(all ? "Scope: all tracked messages" : `Scope: messages from the last ${hours}h`);

  console.log("[slack] reading #hall-of-fame history...");
  const announced = await fetchAnnouncedOrigins(slack);
  console.log(`[slack] ${announced.size} origins currently announced\n`);

  const dbUrl = new URL(process.env.DATABASE_URL);
  dbUrl.search = "";
  const db = new Client({
    connectionString: dbUrl.toString(),
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 20000,
  });
  await db.connect();

  try {
    const { rows } = all
      ? await db.query(
          `SELECT "messageId", "channelId", stars, "postedMessageId", announce
             FROM "Message" ORDER BY "messageId" ASC`
        )
      : await db.query(
          `SELECT "messageId", "channelId", stars, "postedMessageId", announce
             FROM "Message" WHERE "messageId" >= $1 ORDER BY "messageId" ASC`,
          [String(Math.floor(Date.now() / 1000) - hours * 3600)]
        );

    console.log(`[db] ${rows.length} row(s) in scope, checking live star counts...`);

    const toPost = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (announced.has(`${row.channelId}/${row.messageId}`)) continue;

      const live = await liveStarCount(slack, row.channelId, row.messageId);
      if (i < rows.length - 1) await delay(CALL_DELAY_MS);

      if (!live.ok) {
        console.log(`  skip ${originLink(row.channelId, row.messageId)} — lookup failed: ${live.error}`);
        continue;
      }
      if (live.stars < STAR_THRESHOLD) continue;

      toPost.push({ ...row, liveStars: live.stars, link: originLink(row.channelId, row.messageId) });
    }

    console.log(`\n${toPost.length} message(s) at/above ${STAR_THRESHOLD}⭐ with no announcement in the channel:\n`);
    for (const entry of toPost) {
      const was = entry.postedMessageId ? ` (was posted as ${entry.postedMessageId}, since deleted)` : " (never posted)";
      console.log(`${apply ? "[sending]" : "[dry-run]"} ${entry.liveStars}⭐  ${entry.link}${was}`);
    }

    if (!toPost.length) return;

    if (!apply) {
      console.log("\nDry run only — nothing was sent. Re-run with --apply to actually post these.");
      return;
    }

    let sent = 0;
    for (const entry of toPost) {
      const text = `⭐ *${entry.liveStars}*\n${entry.link}`;
      const posted = await slack.chat.postMessage({ channel: HALL_OF_FAME_CHANNEL, text });

      await db.query(
        `UPDATE "Message" SET stars = $2, "postedMessageId" = $3, announce = false WHERE "messageId" = $1`,
        [entry.messageId, entry.liveStars, posted.ts]
      );

      sent++;
      console.log(`sent (${sent}/${toPost.length}): ${entry.liveStars}⭐ -> postedMessageId=${posted.ts}`);
      await delay(POST_DELAY_MS);
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
