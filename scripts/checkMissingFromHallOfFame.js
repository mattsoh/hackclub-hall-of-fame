// Finds messages that should be in #hall-of-fame but aren't.
//
// An adaptation of checkLast24h.js that doesn't take the DB at its word.
// checkLast24h.js filters on the DB's cached `stars` and `postedMessageId`
// columns, both of which go stale exactly when it matters most — during
// downtime, reaction_added never fires, so `stars` freezes below the
// threshold and the row looks ineligible. And a row whose announcement was
// later deleted from the channel still carries a postedMessageId, so it looks
// covered when it isn't.
//
// This checks two things against reality instead:
//   1. the LIVE star count from Slack (reactions.get), not the cached column
//   2. whether an announcement for that origin actually exists in
//      #hall-of-fame right now, read off the permalinks announcements embed
//
// Read-only: never writes to the DB and never posts anything.
//
// Usage:
//   node scripts/checkMissingFromHallOfFame.js            # last 24 hours
//   node scripts/checkMissingFromHallOfFame.js --hours 72
//   node scripts/checkMissingFromHallOfFame.js --all      # every unposted row
//
// Requires SLACK_BOLT_TOKEN and DATABASE_URL in .env.

require("dotenv").config();
const { WebClient } = require("@slack/web-api");
const { Client } = require("pg");

const HALL_OF_FAME_CHANNEL = "C028VGT0JMQ";
const STAR_THRESHOLD = 5;
// reactions.get and conversations.history are both Tier 3 (~50/min).
const CALL_DELAY_MS = 1250;
// How far back to read #hall-of-fame when building the "already announced"
// set. Generous on purpose: a message announced days after it was posted must
// still register as covered.
const ANNOUNCED_LOOKBACK_DAYS = 90;
const PERMALINK = /archives\/([A-Z0-9]+)\/p(\d+)/;

function parseArgs(argv) {
  const all = argv.includes("--all");
  const hoursIndex = argv.indexOf("--hours");
  const hours = hoursIndex !== -1 ? Number(argv[hoursIndex + 1]) : 24;
  if (!all && (!Number.isFinite(hours) || hours <= 0)) {
    throw new Error("--hours needs a positive number");
  }
  return { all, hours };
}

function originLink(channel, ts) {
  return `https://hackclub.slack.com/archives/${channel}/p${String(ts).replace(".", "")}`;
}

function tsSeconds(ts) {
  return Number(String(ts ?? "").split(".")[0]) || 0;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A message's author starring their own post shouldn't push it over the
// threshold — mirrors starCountFromMessage in src/utils/stars.ts. Slack
// truncates `users` at 50, so this only corrects counts near the threshold,
// which is exactly where the decision is made.
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

// Every origin currently announced in #hall-of-fame. Keyed on the origin
// message the announcement links to, not on the announcement's own ts, so a
// message announced more than once still counts as covered exactly once.
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

async function connectDb() {
  const dbUrl = new URL(process.env.DATABASE_URL);
  dbUrl.search = "";
  const db = new Client({
    connectionString: dbUrl.toString(),
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 20000,
  });
  await db.connect();
  return db;
}

async function main() {
  const { all, hours } = parseArgs(process.argv.slice(2));
  const slack = new WebClient(process.env.SLACK_BOLT_TOKEN);

  console.log(all ? "Scope: every unposted row in the DB" : `Scope: messages from the last ${hours}h`);

  console.log("[slack] reading #hall-of-fame history...");
  const announced = await fetchAnnouncedOrigins(slack);
  console.log(`[slack] ${announced.size} origins currently announced\n`);

  const db = await connectDb();
  try {
    const rows = all
      ? (
          await db.query(
            `SELECT "messageId", "channelId", stars, "postedMessageId", announce
               FROM "Message"
              WHERE "postedMessageId" IS NULL OR "postedMessageId" = ''
              ORDER BY "messageId" ASC`
          )
        ).rows
      : (
          await db.query(
            `SELECT "messageId", "channelId", stars, "postedMessageId", announce
               FROM "Message"
              WHERE "messageId" >= $1
              ORDER BY "messageId" ASC`,
            [String(Math.floor(Date.now() / 1000) - hours * 3600)]
          )
        ).rows;

    console.log(`[db] ${rows.length} row(s) in scope, checking live star counts...\n`);

    const missing = [];
    const announcementGone = [];
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const live = await liveStarCount(slack, row.channelId, row.messageId);

      if (!live.ok) {
        errors.push({ ...row, error: live.error });
      } else {
        const isAnnounced = announced.has(`${row.channelId}/${row.messageId}`);
        const entry = {
          ...row,
          liveStars: live.stars,
          link: originLink(row.channelId, row.messageId),
        };

        if (live.stars >= STAR_THRESHOLD && !isAnnounced) {
          // The actual answer to "should be in the channel but isn't".
          missing.push(entry);
        } else if (row.postedMessageId && !isAnnounced) {
          // DB thinks it was announced, but no announcement is in the channel
          // — deleted, or posted outside the lookback window.
          announcementGone.push(entry);
        }
      }

      if ((i + 1) % 25 === 0 || i === rows.length - 1) {
        console.log(`[check] ${i + 1}/${rows.length}`);
      }
      if (i < rows.length - 1) await delay(CALL_DELAY_MS);
    }

    console.log("\n=== Should be in #hall-of-fame but isn't ===");
    if (missing.length === 0) {
      console.log("(none)");
    } else {
      missing.sort((a, b) => b.liveStars - a.liveStars);
      for (const entry of missing) {
        const drift = entry.liveStars !== entry.stars ? ` (DB cached ${entry.stars})` : "";
        const held = entry.announce ? "" : " [announce=false, deliberately held back]";
        const ghost = entry.postedMessageId ? " [DB says posted, announcement not in channel]" : "";
        const when = new Date(tsSeconds(entry.messageId) * 1000).toISOString();
        console.log(`  ${entry.liveStars}⭐${drift}  ${when}  ${entry.link}${held}${ghost}`);
      }
    }
    console.log(`\nTotal: ${missing.length}`);

    if (announcementGone.length) {
      console.log(`\n=== Announcement missing from channel, below threshold now (${announcementGone.length}) ===`);
      for (const entry of announcementGone) {
        console.log(`  ${entry.liveStars}⭐  ${entry.link}`);
      }
    }

    if (errors.length) {
      console.log(`\n=== Lookup errors (${errors.length}) ===`);
      for (const entry of errors) {
        console.log(`  ${originLink(entry.channelId, entry.messageId)} — ${entry.error}`);
      }
    }

    console.log(
      "\nNote: this only sees messages the DB already tracks. A message starred " +
        "while the bot was down has no row at all and cannot appear here — that " +
        "gap needs a live channel scan."
    );
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
