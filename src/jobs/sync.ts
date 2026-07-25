import { App } from "@slack/bolt";
import { Client } from "pg";
import { withPgClient } from "../utils/pg";
import { logError, logInfo, postLog, LOG_CHANNEL } from "../utils/log";

const HALL_OF_FAME_CHANNEL = "C028VGT0JMQ";
// Matched by name, not bot_id: the app's bot_id changed at least once (an app
// reinstall/token rotation), so relying on bot name is more durable.
const HALL_OF_FAME_BOT_NAME = "Hall of Fame";
const STAR_LINE = /^(?:⭐|:star:) \*(\d+)\*/;
const PERMALINK = /archives\/([A-Z0-9]+)\/p(\d+)/;
const REACTION_CALL_DELAY_MS = 200;
const SEND_DELAY_MS = 1200;
const PENDING_AUTO_SEND_THRESHOLD = 10;
const THREAD_CHUNK_SIZE = 40;

interface SlackPost {
  stars: number;
  originChannel?: string;
  originTs?: string;
}

interface DbRow {
  messageId: string;
  channelId: string;
  stars: number;
  postedMessageId: string | null;
}

function parsePermalink(text: string): { channel: string; ts: string } | null {
  const match = PERMALINK.exec(text || "");
  if (!match) return null;
  const [, channel, raw] = match;
  const ts = raw.length > 6 ? `${raw.slice(0, -6)}.${raw.slice(-6)}` : raw;
  return { channel, ts };
}

function originLink(channel: string, ts: string): string {
  return `https://hackclub.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHallOfFameHistory(app: App): Promise<Map<string, SlackPost>> {
  const messages: Record<string, any>[] = [];
  let cursor: string | undefined;

  do {
    const res = await app.client.conversations.history({
      channel: HALL_OF_FAME_CHANNEL,
      cursor,
      limit: 200,
    });
    messages.push(...((res.messages as Record<string, any>[]) ?? []));
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);

  const posts = new Map<string, SlackPost>();
  for (const message of messages) {
    if (!message.bot_id) continue;
    if (!message.bot_profile || message.bot_profile.name !== HALL_OF_FAME_BOT_NAME) continue;
    const match = STAR_LINE.exec(message.text || "");
    if (!match) continue;
    const origin = parsePermalink(message.text);
    posts.set(message.ts, {
      stars: Number(match[1]),
      originChannel: origin?.channel,
      originTs: origin?.ts,
    });
  }
  return posts;
}

async function getLiveStarCount(app: App, channel: string, ts: string): Promise<{ ok: true; stars: number } | { ok: false }> {
  try {
    const res = await app.client.reactions.get({ channel, timestamp: ts });
    const reactions = (res.message as Record<string, any> | undefined)?.reactions as Array<Record<string, any>> | undefined;
    const star = reactions?.find((r) => r.name === "star");
    return { ok: true, stars: star ? star.count : 0 };
  } catch {
    return { ok: false };
  }
}

async function runSyncJobBody(app: App, db: Client): Promise<void> {
  await logInfo(app.client, "Starting sync job...");

  await logInfo(app.client, "Sync job: fetching #hall-of-fame history from Slack...");
  const slackPosts = await fetchHallOfFameHistory(app);
  await logInfo(app.client, `Sync job: fetched ${slackPosts.size} posted messages from Slack.`);

  await logInfo(app.client, "Sync job: loading posted messages from DB...");
  const postedRes = await db.query<DbRow>(
    `SELECT "messageId", "channelId", stars, "postedMessageId" FROM "Message"
     WHERE "postedMessageId" IS NOT NULL AND "postedMessageId" != ''`
  );
  const dbPostedByPostedId = new Map(postedRes.rows.map((r) => [r.postedMessageId as string, r]));
  await logInfo(app.client, `Sync job: loaded ${postedRes.rows.length} posted messages from DB.`);

  const missingFromDb: Array<{ postedTs: string } & SlackPost> = [];
  const starMismatches: Array<{ postedTs: string; messageId: string; slackStars: number; dbStars: number }> = [];
  for (const [ts, post] of slackPosts) {
    const dbPost = dbPostedByPostedId.get(ts);
    if (!dbPost) {
      missingFromDb.push({ postedTs: ts, ...post });
    } else if (dbPost.stars !== post.stars) {
      starMismatches.push({ postedTs: ts, messageId: dbPost.messageId, slackStars: post.stars, dbStars: dbPost.stars });
    }
  }

  const deletedFromSlack = postedRes.rows.filter((r) => !slackPosts.has(r.postedMessageId as string));

  // Backfill missing-from-db rows (already posted in Slack — safe, announce=true).
  // Dedupe by origin message, keeping the highest star count if the same origin
  // was announced more than once historically.
  const byOrigin = new Map<string, { postedTs: string } & SlackPost>();
  for (const row of missingFromDb) {
    if (!row.originChannel || !row.originTs) continue;
    const key = `${row.originChannel}:${row.originTs}`;
    const existing = byOrigin.get(key);
    if (!existing || row.stars > existing.stars) byOrigin.set(key, row);
  }

  if (byOrigin.size > 0) {
    await logInfo(app.client, `Sync job: backfilling ${byOrigin.size} messages missing from DB...`);
  }
  let backfilledCount = 0;
  for (const row of byOrigin.values()) {
    await db.query(
      `INSERT INTO "Message" ("messageId", "channelId", stars, "postedMessageId", announce)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT ("messageId") DO UPDATE SET
         "channelId" = EXCLUDED."channelId",
         stars = EXCLUDED.stars,
         "postedMessageId" = EXCLUDED."postedMessageId",
         announce = true`,
      [row.originTs, row.originChannel, row.stars, row.postedTs]
    );
    backfilledCount++;
  }
  if (backfilledCount > 0) {
    await logInfo(app.client, `Sync job: backfilled ${backfilledCount} messages into DB.`);
  }

  // Check every currently-unposted row against its live Slack star count.
  const unpostedRes = await db.query<DbRow>(
    `SELECT "messageId", "channelId", stars, "postedMessageId" FROM "Message"
     WHERE "postedMessageId" IS NULL OR "postedMessageId" = ''`
  );
  await logInfo(app.client, `Sync job: checking live star counts for ${unpostedRes.rows.length} unposted messages...`);

  let driftedCount = 0;
  let lookupErrors = 0;
  for (const row of unpostedRes.rows) {
    const result = await getLiveStarCount(app, row.channelId, row.messageId);
    if (!result.ok) {
      lookupErrors++;
    } else if (result.stars !== row.stars) {
      await db.query(`UPDATE "Message" SET stars = $2, announce = false WHERE "messageId" = $1`, [row.messageId, result.stars]);
      driftedCount++;
    }
    await delay(REACTION_CALL_DELAY_MS);
  }
  await logInfo(
    app.client,
    `Sync job: finished live star check — ${driftedCount} drifted, ${lookupErrors} lookup errors out of ${unpostedRes.rows.length}.`
  );

  // Rows that are unposted, qualify (>= 5 live stars), and haven't been
  // explicitly excluded (announce=false is the default outcome of the drift
  // correction above, but may also have been set by postMissingToThread.js).
  const pendingRes = await db.query<DbRow>(
    `SELECT "messageId", "channelId", stars, "postedMessageId" FROM "Message"
     WHERE announce = false AND stars >= 5 AND ("postedMessageId" IS NULL OR "postedMessageId" = '')`
  );
  const pending = pendingRes.rows;
  await logInfo(app.client, `Sync job: found ${pending.length} pending announcements.`);

  const nothingFound =
    backfilledCount === 0 && deletedFromSlack.length === 0 && starMismatches.length === 0 && pending.length === 0;

  if (nothingFound) {
    await logInfo(app.client, "Sync job: no issues found.");
    return;
  }

  const baseSummary =
    `Sync job found issues:\n` +
    `- missing from DB (backfilled): ${backfilledCount}\n` +
    `- deleted from Slack: ${deletedFromSlack.length}\n` +
    `- star mismatches: ${starMismatches.length}\n` +
    `- lookup errors: ${lookupErrors}`;

  if (pending.length > 0 && pending.length <= PENDING_AUTO_SEND_THRESHOLD) {
    await logInfo(app.client, `Sync job: auto-sending ${pending.length} pending announcements...`);
    const sentLines: string[] = [];
    for (const row of pending) {
      const link = originLink(row.channelId, row.messageId);
      const text = `⭐ *${row.stars}*\n${link}`;
      const posted = await app.client.chat.postMessage({ channel: HALL_OF_FAME_CHANNEL, text });

      await db.query(`UPDATE "Message" SET "postedMessageId" = $2, announce = true WHERE "messageId" = $1`, [
        row.messageId,
        posted.ts as string,
      ]);
      await db.query(`UPDATE "AppState" SET "newPosts" = "newPosts" + 1 WHERE id = 1`);

      sentLines.push(`${row.stars}⭐ ${link}`);
      await delay(SEND_DELAY_MS);
    }

    await postLog(
      app.client,
      `${baseSummary}\n- pending announcements: ${pending.length} (<= ${PENDING_AUTO_SEND_THRESHOLD}, sent automatically):\n${sentLines.join("\n")}`,
      true
    );
  } else if (pending.length > PENDING_AUTO_SEND_THRESHOLD) {
    const alertTs = await postLog(
      app.client,
      `${baseSummary}\n- pending announcements: ${pending.length} (> ${PENDING_AUTO_SEND_THRESHOLD}, NOT auto-sent — see thread)`,
      true
    );

    if (alertTs) {
      const lines = pending.map((row) => `${row.stars}⭐ ${originLink(row.channelId, row.messageId)}`);
      for (let i = 0; i < lines.length; i += THREAD_CHUNK_SIZE) {
        const chunk = lines.slice(i, i + THREAD_CHUNK_SIZE).join("\n");
        await app.client.chat.postMessage({ channel: LOG_CHANNEL, thread_ts: alertTs, text: chunk });
      }
    }
  } else {
    await postLog(app.client, baseSummary, true);
  }
}

export async function runSyncJob(app: App): Promise<void> {
  try {
    await withPgClient((db) => runSyncJobBody(app, db));
  } catch (err) {
    await logError(app.client, "Sync job failed", err);
  }
}
