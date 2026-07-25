// Compares the DB against Slack (the source of truth) across two populations:
//
//   1. "missing from DB"    — messages already announced in #hall-of-fame that
//                             the DB has no record of (or lost track of).
//   2. "drifted unposted"   — DB rows that were never announced, whose live
//                             Slack star count no longer matches what the DB
//                             has stored (and may now be >= the 5-star
//                             threshold, meaning they should've been posted).
//
// This is entirely read-only — it never writes to the DB or posts to Slack.
//
// Usage: node scripts/diffNinjaHistory.js
// Requires SLACK_BOLT_TOKEN and DATABASE_URL in .env.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { WebClient } = require("@slack/web-api");
const { Client } = require("pg");

const HALL_OF_FAME_CHANNEL = "C028VGT0JMQ";
// Matched by name, not bot_id: the app's bot_id changed at least once (an app
// reinstall/token rotation around 2024-03), so B028V7JBD5H (2021-07..2024-03)
// and B06LLPAFP09 (2024-03..present) are both legitimately "Ninja Ten Thousand".
const HALL_OF_FAME_BOT_NAME = "Hall of Fame";
const STAR_LINE = /^(?:⭐|:star:) \*(\d+)\*/;
const PERMALINK = /archives\/([A-Z0-9]+)\/p(\d+)/;
const OUTPUT_DIR = path.join(__dirname, "output");
const REACTION_CALL_DELAY_MS = 200;

function parsePermalink(text) {
  const match = PERMALINK.exec(text || "");
  if (!match) return null;
  const [, channel, raw] = match;
  const ts = raw.length > 6 ? `${raw.slice(0, -6)}.${raw.slice(-6)}` : raw;
  return { channel, ts };
}

function formatDate(ts) {
  const n = Number(ts);
  if (!n) return "unknown";
  return new Date(n * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function originLink(channel, ts) {
  return `https://hackclub.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
}

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

function summarizeByYear(entries, tsField) {
  const byYear = new Map();
  for (const entry of entries) {
    const year = new Date(Number(entry[tsField]) * 1000).getUTCFullYear();
    byYear.set(year, (byYear.get(year) || 0) + 1);
  }
  return [...byYear.entries()].sort((a, b) => a[0] - b[0]);
}

async function fetchSlackHistory(client) {
  const messages = [];
  let cursor;
  let page = 0;

  do {
    page++;
    console.log(`[slack] fetching page ${page}...`);
    const res = await client.conversations.history({
      channel: HALL_OF_FAME_CHANNEL,
      cursor,
      limit: 200,
    });

    messages.push(...res.messages);
    cursor = res.response_metadata && res.response_metadata.next_cursor;
    console.log(`[slack] page ${page}: +${res.messages.length} messages (${messages.length} total)`);
  } while (cursor);

  console.log(`[slack] done, ${messages.length} messages fetched, parsing star posts...`);

  const ownBotIds = new Map();
  const otherBotIds = new Map();
  const posts = new Map();
  for (const message of messages) {
    if (!message.bot_id) continue; // skip human messages that happen to match the star-line format
    if (!message.bot_profile || message.bot_profile.name !== HALL_OF_FAME_BOT_NAME) {
      otherBotIds.set(message.bot_id, (otherBotIds.get(message.bot_id) || 0) + 1);
      continue;
    }
    ownBotIds.set(message.bot_id, (ownBotIds.get(message.bot_id) || 0) + 1);
    const match = STAR_LINE.exec(message.text || "");
    if (!match) continue;
    const origin = parsePermalink(message.text);
    posts.set(message.ts, {
      stars: Number(match[1]),
      originChannel: origin && origin.channel,
      originTs: origin && origin.ts,
    });
  }
  console.log(`[slack] ${posts.size} of those are star posts from "${HALL_OF_FAME_BOT_NAME}"`);
  console.log(`[slack] "${HALL_OF_FAME_BOT_NAME}" bot_id(s) seen: ${[...ownBotIds.entries()].map(([id, c]) => `${id} (${c})`).join(", ")}`);
  if (otherBotIds.size) {
    console.log(`[slack] found messages from ${otherBotIds.size} other bot(s), ignored:`);
    for (const [botId, count] of otherBotIds) {
      console.log(`  bot_id=${botId}: ${count} message(s)`);
    }
  }
  return posts;
}

async function fetchDbPostedRows(db) {
  console.log("[db] querying posted rows...");
  const res = await db.query(
    `SELECT "messageId", "channelId", stars, "postedMessageId"
     FROM "Message"
     WHERE "postedMessageId" IS NOT NULL AND "postedMessageId" != ''`
  );
  console.log(`[db] ${res.rows.length} posted rows found`);

  const posts = new Map();
  for (const row of res.rows) posts.set(row.postedMessageId, row);
  return posts;
}

async function fetchDbUnpostedRows(db) {
  console.log("[db] querying unposted rows...");
  const res = await db.query(
    `SELECT "messageId", "channelId", stars
     FROM "Message"
     WHERE "postedMessageId" IS NULL OR "postedMessageId" = ''
     ORDER BY stars DESC`
  );
  console.log(`[db] ${res.rows.length} unposted rows found`);
  return res.rows;
}

async function getLiveStarCount(client, channel, ts) {
  try {
    const res = await client.reactions.get({ channel, timestamp: ts });
    const star = (res.message.reactions || []).find((r) => r.name === "star");
    return { ok: true, stars: star ? star.count : 0 };
  } catch (err) {
    return { ok: false, error: (err.data && err.data.error) || err.message };
  }
}

async function checkUnpostedAgainstLive(client, rows) {
  const drifted = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const result = await getLiveStarCount(client, row.channelId, row.messageId);

    if (!result.ok) {
      errors.push({ ...row, error: result.error });
    } else if (result.stars !== row.stars) {
      drifted.push({ ...row, dbStars: row.stars, liveStars: result.stars });
    }

    if ((i + 1) % 50 === 0 || i === rows.length - 1) {
      console.log(`[live-check] ${i + 1}/${rows.length} checked, ${drifted.length} drifted so far`);
    }

    await new Promise((resolve) => setTimeout(resolve, REACTION_CALL_DELAY_MS));
  }

  return { drifted, errors };
}

async function main() {
  console.log("Starting diff check...");

  const slackClient = new WebClient(process.env.SLACK_BOLT_TOKEN);

  const dbUrl = new URL(process.env.DATABASE_URL);
  dbUrl.search = "";
  const db = new Client({ connectionString: dbUrl.toString(), ssl: { rejectUnauthorized: true } });

  console.log("[db] connecting...");
  await db.connect();
  console.log("[db] connected");

  try {
    // --- Part 1: missing from DB / star mismatches / deleted from slack ---
    const [slackPosts, dbPostedRows] = await Promise.all([
      fetchSlackHistory(slackClient),
      fetchDbPostedRows(db),
    ]);

    console.log("[diff] comparing slack posts against db rows...");
    const missingFromDb = [];
    const starMismatches = [];
    for (const [ts, slackPost] of slackPosts) {
      const dbPost = dbPostedRows.get(ts);
      if (!dbPost) {
        missingFromDb.push({ postedTs: ts, ...slackPost });
      } else if (dbPost.stars !== slackPost.stars) {
        starMismatches.push({ postedTs: ts, messageId: dbPost.messageId, slackStars: slackPost.stars, dbStars: dbPost.stars });
      }
    }

    const deletedFromSlack = [];
    for (const [ts, dbPost] of dbPostedRows) {
      if (!slackPosts.has(ts)) deletedFromSlack.push(dbPost);
    }
    console.log("[diff] part 1 done\n");

    // --- Part 2: drifted unposted rows (never announced, live count checked) ---
    const unpostedRows = await fetchDbUnpostedRows(db);
    console.log(`[live-check] checking ${unpostedRows.length} unposted rows against live Slack reactions...`);
    const { drifted: driftedUnposted, errors: lookupErrors } = await checkUnpostedAgainstLive(slackClient, unpostedRows);
    const aboveThreshold = driftedUnposted.filter((r) => r.liveStars >= 5);
    console.log("[live-check] part 2 done\n");

    // --- Report ---
    console.log(`Slack posts found: ${slackPosts.size}`);
    console.log(`DB posted rows:    ${dbPostedRows.size}`);
    console.log(`DB unposted rows:  ${unpostedRows.length}`);
    console.log();

    console.log(`=== Posted in Slack but missing from DB: ${missingFromDb.length} ===`);
    if (missingFromDb.length) {
      const withDates = missingFromDb.map((p) => ({ ...p, date: formatDate(p.originTs || p.postedTs) }));
      const byYear = summarizeByYear(withDates, "originTs");
      console.log("By year: " + byYear.map(([y, c]) => `${y}: ${c}`).join(", "));

      const top = [...withDates].sort((a, b) => b.stars - a.stars).slice(0, 15);
      console.log(`Top ${top.length} by star count:`);
      for (const p of top) {
        const link = p.originChannel ? originLink(p.originChannel, p.originTs) : "(no link found)";
        console.log(`  ${p.stars}⭐  ${p.date}  ${link}`);
      }

      const file = writeCsv("missing-from-db.csv", withDates, ["postedTs", "originChannel", "originTs", "date", "stars"]);
      console.log(`Full list (${missingFromDb.length} rows) written to ${file}`);
    }
    console.log();

    console.log(`=== In DB but missing/deleted from Slack: ${deletedFromSlack.length} ===`);
    for (const p of deletedFromSlack.slice(0, 15)) {
      console.log(`  messageId=${p.messageId} postedMessageId=${p.postedMessageId} channel=${p.channelId} dbStars=${p.stars}`);
    }
    console.log();

    console.log(`=== Star count mismatches (posted messages): ${starMismatches.length} ===`);
    for (const m of starMismatches) {
      console.log(`  messageId=${m.messageId} postedTs=${m.postedTs} slack=${m.slackStars} db=${m.dbStars}`);
    }
    console.log();

    console.log(`=== Drifted unposted rows (live != db): ${driftedUnposted.length} ===`);
    console.log(`=== Of those, now at/above 5-star threshold (never posted): ${aboveThreshold.length} ===`);
    if (aboveThreshold.length) {
      const withDates = aboveThreshold.map((p) => ({ ...p, date: formatDate(p.messageId) }));
      const byYear = summarizeByYear(withDates, "messageId");
      console.log("By year (origin message date): " + byYear.map(([y, c]) => `${y}: ${c}`).join(", "));

      const top = [...withDates].sort((a, b) => b.liveStars - a.liveStars).slice(0, 15);
      console.log(`Top ${top.length} by live star count:`);
      for (const p of top) {
        console.log(`  db=${p.dbStars} live=${p.liveStars}  ${p.date}  ${originLink(p.channelId, p.messageId)}`);
      }
    }
    if (driftedUnposted.length) {
      const withDates = driftedUnposted.map((p) => ({ ...p, date: formatDate(p.messageId) }));
      const file = writeCsv("drifted-unposted.csv", withDates, ["messageId", "channelId", "date", "dbStars", "liveStars"]);
      console.log(`Full drifted list (${driftedUnposted.length} rows) written to ${file}`);
    }
    if (lookupErrors.length) {
      const file = writeCsv("unposted-lookup-errors.csv", lookupErrors, ["messageId", "channelId", "stars", "error"]);
      console.log(`Lookup errors (${lookupErrors.length} rows) written to ${file}`);
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
