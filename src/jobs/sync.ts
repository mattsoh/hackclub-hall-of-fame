import { App } from "@slack/bolt";
import { Client } from "pg";
import { withPgClient } from "../utils/pg";
import { logError, logInfo, postLog, LOG_CHANNEL } from "../utils/log";
import { getLiveStarCount, slackErrorCode } from "../utils/stars";

const HALL_OF_FAME_CHANNEL = "C028VGT0JMQ";
// Matched by name, not bot_id: the app's bot_id changed at least once (an app
// reinstall/token rotation), so relying on bot name is more durable.
const HALL_OF_FAME_BOT_NAME = "Hall of Fame";
const STAR_LINE = /^(?:⭐|:star:) \*(\d+)\*/;
const PERMALINK = /archives\/([A-Z0-9]+)\/p(\d+)/;

// reactions.get is a Slack Tier 3 method: ~50 requests per minute. Pacing at
// 1250ms keeps us just under that ceiling. The previous 200ms delay drove
// ~300 requests/minute, so every run spent most of its time in Bolt's 429
// backoff (10s per rejected call) and made no faster progress than this does
// — it just produced a wall of rate-limit warnings while doing so.
const REACTION_CALL_DELAY_MS = 1250;
// conversations.history is Tier 3 as well, but only runs ~40 times per sync.
const HISTORY_CALL_DELAY_MS = 1250;
// chat.postMessage is limited to roughly one message per second per channel.
const SEND_DELAY_MS = 1200;

// Hard ceiling on reactions.get calls per run. At the pacing above this caps a
// run at ~25 minutes. There is no bulk reaction API, so a single run cannot
// cover every tracked message without running for hours; instead each run
// checks everything recent plus a rotating slice of the rest of the window
// (see selectRowsToCheck).
const MAX_REACTION_CALLS_PER_RUN = 1200;
// Messages younger than this are checked on every run — practically all star
// activity happens here. Older ones are reconciled by rotation.
const RECENT_WINDOW_DAYS = 30;
// Messages older than this are left alone entirely. Their star counts have
// long since stopped moving, and the announcements predating the last app
// reinstall can't be edited by this token anyway, so scanning them only spends
// a rate-limited API budget that the recent window has a real use for.
const MAX_MESSAGE_AGE_DAYS = 365;

const PENDING_AUTO_SEND_THRESHOLD = 10;
const THREAD_CHUNK_SIZE = 40;
const ERROR_SAMPLE_SIZE = 10;

// Slack errors that will never succeed on a retry: the announcement was
// authored by a different app installation, or it no longer exists. Retrying
// these every run just burns API calls and pings a human for something no
// amount of retrying can fix.
const PERMANENT_UPDATE_ERRORS = new Set(["cant_update_message", "message_not_found", "channel_not_found"]);

interface SlackPost {
  stars: number;
  botId?: string;
  originChannel?: string;
  originTs?: string;
}

interface DbRow {
  messageId: string;
  channelId: string;
  stars: number;
  postedMessageId: string | null;
}

interface ScanRow extends DbRow {
  isPosted: boolean;
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

// Slack timestamps are "<unix seconds>.<microseconds>".
function tsSeconds(ts: string | null | undefined): number {
  return Number((ts ?? "").split(".")[0]) || 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The bot_id the current token posts under. Announcements posted by an earlier
// installation of the app carry a different bot_id and cannot be edited with
// this token — Slack rejects those chat.update calls with cant_update_message.
async function fetchOwnBotId(app: App): Promise<string | undefined> {
  try {
    const res = await app.client.auth.test();
    return typeof res.bot_id === "string" ? res.bot_id : undefined;
  } catch (err) {
    await logError(app.client, "Sync job: could not resolve own bot_id (assuming all announcements editable)", err);
    return undefined;
  }
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
    if (cursor) await delay(HISTORY_CALL_DELAY_MS);
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
      botId: message.bot_id as string,
      originChannel: origin?.channel,
      originTs: origin?.ts,
    });
  }
  return posts;
}

// Everything within RECENT_WINDOW_DAYS, plus as much of the rest of the
// one-year window as the per-run budget allows, resuming from where the last
// run stopped so the whole window is covered over successive runs. Anything
// older than MAX_MESSAGE_AGE_DAYS is ignored.
function selectRowsToCheck(
  rows: ScanRow[],
  cursor: number
): { toCheck: ScanRow[]; nextCursor: number; olderTotal: number; skippedTooOld: number } {
  const now = Math.floor(Date.now() / 1000);
  const recentCutoff = now - RECENT_WINDOW_DAYS * 24 * 60 * 60;
  const ageCutoff = now - MAX_MESSAGE_AGE_DAYS * 24 * 60 * 60;

  const inWindow = rows.filter((r) => tsSeconds(r.messageId) >= ageCutoff);
  const recent = inWindow.filter((r) => tsSeconds(r.messageId) >= recentCutoff);
  const older = inWindow
    .filter((r) => tsSeconds(r.messageId) < recentCutoff)
    .sort((a, b) => tsSeconds(a.messageId) - tsSeconds(b.messageId));

  // Resume just past the cursor; when the cursor is at (or past) the end,
  // findIndex returns -1 and the scan wraps around to the oldest row.
  const resumeAt = older.findIndex((r) => tsSeconds(r.messageId) > cursor);
  const rotated = resumeAt === -1 ? older : [...older.slice(resumeAt), ...older.slice(0, resumeAt)];

  const olderBudget = Math.max(0, MAX_REACTION_CALLS_PER_RUN - recent.length);
  const olderSlice = rotated.slice(0, olderBudget);
  const last = olderSlice[olderSlice.length - 1];

  return {
    toCheck: [...recent, ...olderSlice],
    nextCursor: last ? tsSeconds(last.messageId) : cursor,
    olderTotal: older.length,
    skippedTooOld: rows.length - inWindow.length,
  };
}

async function runSyncJobBody(app: App, db: Client): Promise<void> {
  await logInfo(app.client, "Starting sync job...");

  const ownBotId = await fetchOwnBotId(app);

  await logInfo(app.client, "Sync job: fetching #hall-of-fame history from Slack...");
  const slackPosts = await fetchHallOfFameHistory(app);
  await logInfo(app.client, `Sync job: fetched ${slackPosts.size} posted messages from Slack.`);

  await logInfo(app.client, "Sync job: loading posted messages from DB...");
  const postedRes = await db.query<DbRow>(
    `SELECT "messageId", "channelId", stars, "postedMessageId" FROM "Message"
     WHERE "postedMessageId" IS NOT NULL AND "postedMessageId" != ''`
  );
  const dbPostedByPostedId = new Map(postedRes.rows.map((r) => [r.postedMessageId as string, r]));
  // Origins already recorded as announced. "Message" is keyed on the origin
  // message, so a row holds exactly one postedMessageId — once any copy of an
  // announcement is recorded, that origin is covered and the remaining copies
  // can never be stored.
  const dbPostedOrigins = new Set(postedRes.rows.map((r) => r.messageId));
  await logInfo(app.client, `Sync job: loaded ${postedRes.rows.length} posted messages from DB.`);

  // An announcement counts as missing only when its *origin* has no row yet.
  // Keying this on the announcement's own ts (as it used to) meant the extra
  // copies of a duplicated announcement were reported missing on every run and
  // "backfilled" every run — and because the set was built from the missing
  // copies alone, it always picked one the DB wasn't pointing at, so each run
  // rewrote postedMessageId to a different copy and the next run swapped it
  // back. The channel has ~362 duplicate announcements across 191 origins, so
  // that was ~191 rows churning in perpetuity and an alert that could never
  // report a clean run.
  const missingFromDb: Array<{ postedTs: string } & SlackPost> = [];
  let duplicateAnnouncements = 0;
  for (const [ts, post] of slackPosts) {
    if (dbPostedByPostedId.has(ts)) continue;
    if (post.originTs && dbPostedOrigins.has(post.originTs)) {
      duplicateAnnouncements++;
      continue;
    }
    missingFromDb.push({ postedTs: ts, ...post });
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
  // Extra copies among origins being backfilled for the first time this run:
  // only one of them can be stored, so the rest are duplicates too.
  duplicateAnnouncements += missingFromDb.length - byOrigin.size;

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

  const unpostedRes = await db.query<DbRow>(
    `SELECT "messageId", "channelId", stars, "postedMessageId" FROM "Message"
     WHERE "postedMessageId" IS NULL OR "postedMessageId" = ''`
  );

  const cursorRes = await db.query<{ lastSyncedTs: string | null }>(
    `SELECT "lastSyncedTs" FROM "AppState" WHERE id = 1`
  );
  const cursor = Number(cursorRes.rows[0]?.lastSyncedTs) || 0;

  // Check tracked messages directly against the LIVE reaction count on the
  // origin message. Slack's reaction state is the only source of truth —
  // comparing the DB to the announcement's displayed text (as this used to
  // do) can't catch the case where both are stale together, e.g. because a
  // reaction event was missed or arrived before the message was posted.
  const scanRows: ScanRow[] = [
    ...postedRes.rows.map((r) => ({ ...r, isPosted: true })),
    ...unpostedRes.rows.map((r) => ({ ...r, isPosted: false })),
  ];
  const { toCheck, nextCursor, olderTotal, skippedTooOld } = selectRowsToCheck(scanRows, cursor);

  await logInfo(
    app.client,
    `Sync job: checking live star counts for ${toCheck.length} of ${scanRows.length} tracked messages ` +
      `(everything from the last ${RECENT_WINDOW_DAYS} days, plus a rotating slice of the ${olderTotal} older ones ` +
      `still inside the ${MAX_MESSAGE_AGE_DAYS}-day window; ${skippedTooOld} older than that are not checked).`
  );

  let starMismatchCorrected = 0;
  let driftedCount = 0;
  let lookupErrors = 0;
  let uneditableCount = 0;
  let deletedAnnouncementCount = 0;
  const transientUpdateErrors: string[] = [];
  const uneditableSamples: string[] = [];
  // Reason -> count, so a run reports *why* lookups failed rather than just
  // how many did.
  const lookupErrorsByReason = new Map<string, number>();

  for (const row of toCheck) {
    const result = await getLiveStarCount(app.client, row.channelId, row.messageId);
    await delay(REACTION_CALL_DELAY_MS);

    if (!result.ok) {
      lookupErrors++;
      const reason = result.error ?? "unknown";
      lookupErrorsByReason.set(reason, (lookupErrorsByReason.get(reason) ?? 0) + 1);
      continue;
    }
    if (result.stars === row.stars) continue;

    if (!row.isPosted) {
      // Correct the count only. This deliberately leaves `announce` alone:
      // setting it to false here (as this used to) meant that noticing a
      // message had been missed was itself what disqualified it from ever
      // being announced, since every other code path refuses to post when
      // the flag is false. That turned every outage into a permanent loss.
      await db.query(`UPDATE "Message" SET stars = $2 WHERE "messageId" = $1`, [row.messageId, result.stars]);
      driftedCount++;
      continue;
    }

    const postedTs = row.postedMessageId as string;
    const announcement = slackPosts.get(postedTs);
    const link = originLink(row.channelId, row.messageId);

    // The announcement is gone from #hall-of-fame — already reported under
    // "deleted from Slack". Keep the DB honest about the live count, but
    // don't spend a chat.update that can only fail.
    if (!announcement) {
      await db.query(`UPDATE "Message" SET stars = $2 WHERE "messageId" = $1`, [row.messageId, result.stars]);
      deletedAnnouncementCount++;
      continue;
    }

    // Posted by a previous installation of the app: Slack will not let this
    // token edit it, so the displayed star count is frozen for good. Record
    // the true count in the DB and report the announcement once rather than
    // failing on it every single run.
    if (ownBotId && announcement.botId && announcement.botId !== ownBotId) {
      await db.query(`UPDATE "Message" SET stars = $2 WHERE "messageId" = $1`, [row.messageId, result.stars]);
      uneditableCount++;
      if (uneditableSamples.length < ERROR_SAMPLE_SIZE) uneditableSamples.push(link);
      continue;
    }

    const text = `⭐ *${result.stars}*\n${link}`;
    try {
      await app.client.chat.update({ channel: HALL_OF_FAME_CHANNEL, ts: postedTs, text });
      await db.query(`UPDATE "Message" SET stars = $2 WHERE "messageId" = $1`, [row.messageId, result.stars]);
      starMismatchCorrected++;
    } catch (err) {
      const code = slackErrorCode(err);
      if (code && PERMANENT_UPDATE_ERRORS.has(code)) {
        // Same situation as the bot_id check above, reached when bot_id alone
        // couldn't tell us (e.g. auth.test failed). Not retryable.
        await db.query(`UPDATE "Message" SET stars = $2 WHERE "messageId" = $1`, [row.messageId, result.stars]);
        uneditableCount++;
        if (uneditableSamples.length < ERROR_SAMPLE_SIZE) uneditableSamples.push(`${link} (${code})`);
      } else {
        // Transient (rate limit, network, Slack outage). Deliberately leave
        // the DB stale so the next run sees the mismatch again and retries —
        // writing it here would hide the drift permanently.
        if (transientUpdateErrors.length < ERROR_SAMPLE_SIZE) {
          transientUpdateErrors.push(`${link} (${code ?? "unknown error"})`);
        }
      }
    }
  }

  await db.query(`UPDATE "AppState" SET "lastSyncedTs" = $1 WHERE id = 1`, [String(nextCursor)]);

  const updateErrors = transientUpdateErrors.length;
  const lookupErrorBreakdown = [...lookupErrorsByReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(", ");
  await logInfo(
    app.client,
    `Sync job: finished live star check — ${starMismatchCorrected} announcements corrected, ${driftedCount} unposted drifted, ` +
      `${uneditableCount} un-editable, ${lookupErrors} lookup errors out of ${toCheck.length} checked` +
      (lookupErrorBreakdown ? ` (${lookupErrorBreakdown}).` : ".")
  );

  // `announce` means "may be auto-announced", consistently with
  // reactionAdd.ts, sendPendingAnnouncements.js, backfillDb.js and
  // postMissingToThread.js. Rows that qualify (>= 5 live stars), were never
  // posted, and haven't been held back are genuinely pending.
  const pendingRes = await db.query<DbRow>(
    `SELECT "messageId", "channelId", stars, "postedMessageId" FROM "Message"
     WHERE announce = true AND stars >= 5 AND ("postedMessageId" IS NULL OR "postedMessageId" = '')`
  );

  // The mirror image: qualifying rows already held back, either by a previous
  // over-threshold run or by a bulk backfill / postMissingToThread.js. Counted
  // for the summary only — they were surfaced when they were held back, and
  // re-listing them on every run would just be noise.
  const heldBackRes = await db.query<{ count: string }>(
    `SELECT count(*) FROM "Message"
     WHERE announce = false AND stars >= 5 AND ("postedMessageId" IS NULL OR "postedMessageId" = '')`
  );
  const heldBackCount = Number(heldBackRes.rows[0]?.count ?? 0);
  // Held to the same one-year window as the star check above. Outside it the
  // stored star count is no longer reconciled against Slack, so announcing on
  // the strength of it would mean posting an unverified number — and posting a
  // year-old message to #hall-of-fame isn't wanted regardless.
  const ageCutoff = Math.floor(Date.now() / 1000) - MAX_MESSAGE_AGE_DAYS * 24 * 60 * 60;
  const pending = pendingRes.rows.filter((r) => tsSeconds(r.messageId) >= ageCutoff);
  const pendingTooOld = pendingRes.rows.length - pending.length;
  await logInfo(
    app.client,
    `Sync job: found ${pending.length} pending announcements` +
      (pendingTooOld > 0 ? ` (plus ${pendingTooOld} older than ${MAX_MESSAGE_AGE_DAYS} days, not announced)` : "") +
      `, and ${heldBackCount} already held back.`
  );

  const nothingFound =
    backfilledCount === 0 &&
    deletedFromSlack.length === 0 &&
    starMismatchCorrected === 0 &&
    updateErrors === 0 &&
    uneditableCount === 0 &&
    pending.length === 0;

  if (nothingFound) {
    await logInfo(app.client, "Sync job: no issues found.");
    return;
  }

  let baseSummary =
    `Sync job found issues:\n` +
    `- missing from DB (backfilled): ${backfilledCount}\n` +
    `- deleted from Slack: ${deletedFromSlack.length}\n` +
    `- star mismatches (corrected): ${starMismatchCorrected}\n` +
    `- update errors (will retry): ${updateErrors}\n` +
    `- lookup errors: ${lookupErrors}` +
    (lookupErrorBreakdown ? ` (${lookupErrorBreakdown})` : "");

  if (duplicateAnnouncements > 0) {
    baseSummary +=
      `\n- duplicate announcements in the channel: ${duplicateAnnouncements} ` +
      `(same origin announced more than once; only one copy can be tracked per message)`;
  }
  if (heldBackCount > 0) {
    baseSummary += `\n- previously held back (announce=false), not re-listed: ${heldBackCount}`;
  }
  if (uneditableCount > 0) {
    baseSummary +=
      `\n- un-editable announcements: ${uneditableCount} (posted by an earlier install of this app; ` +
      `DB star counts corrected, but the messages in #hall-of-fame stay stale — they can only be fixed by ` +
      `deleting and reposting them)`;
    baseSummary += `\n  e.g. ${uneditableSamples.join(", ")}`;
  }
  if (deletedAnnouncementCount > 0) {
    baseSummary += `\n- stale counts on deleted announcements (DB corrected): ${deletedAnnouncementCount}`;
  }
  if (transientUpdateErrors.length > 0) {
    baseSummary += `\n  failed updates: ${transientUpdateErrors.join(", ")}`;
  }

  let summary = baseSummary;
  const threadSections: Array<{ title: string; lines: string[] }> = [];

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
    summary += `\n- pending announcements: ${pending.length} (<= ${PENDING_AUTO_SEND_THRESHOLD}, sent automatically):\n${sentLines.join("\n")}`;
  } else if (pending.length > PENDING_AUTO_SEND_THRESHOLD) {
    // A batch this size means something went wrong (an outage, a long gap in
    // reaction events) rather than a normal trickle, and dumping it into
    // #hall-of-fame at once isn't wanted. Record that decision by clearing
    // `announce`, which holds them back for good — not just for this run, but
    // against reactionAdd.ts too, so a single new star on a stale message
    // can't leak one into the channel later. Re-posting any of them is then a
    // deliberate act: flip the flag back and let sendPendingAnnouncements.js
    // pick them up.
    await db.query(`UPDATE "Message" SET announce = false WHERE "messageId" = ANY($1::text[])`, [
      pending.map((row) => row.messageId),
    ]);
    summary += `\n- pending announcements: ${pending.length} (> ${PENDING_AUTO_SEND_THRESHOLD}, NOT posted — held back, see thread)`;
    threadSections.push({
      title: `Held back — too many to post at once (${pending.length} > ${PENDING_AUTO_SEND_THRESHOLD}). Not posted, and won't be unless you flip announce back:`,
      lines: pending.map((row) => `${row.stars}⭐ ${originLink(row.channelId, row.messageId)}`),
    });
  }

  const alertTs = await postLog(app.client, summary, true);
  if (!alertTs) return;

  for (const section of threadSections) {
    for (let i = 0; i < section.lines.length; i += THREAD_CHUNK_SIZE) {
      const chunk = section.lines.slice(i, i + THREAD_CHUNK_SIZE).join("\n");
      const header = i === 0 ? `*${section.title}*\n` : "";
      await app.client.chat.postMessage({ channel: LOG_CHANNEL, thread_ts: alertTs, text: `${header}${chunk}` });
      await delay(SEND_DELAY_MS);
    }
  }
}

// A run can take tens of minutes. The job fires on every server start as well
// as on a timer, so without this guard a restart mid-run (or a slow run
// overrunning its interval) would put two scans on the same data at once and
// double the API pressure that this job is already constrained by.
let syncRunning = false;

export async function runSyncJob(app: App): Promise<void> {
  if (syncRunning) {
    await logInfo(app.client, "Sync job: previous run still in progress, skipping this one.");
    return;
  }
  syncRunning = true;
  try {
    await withPgClient((db) => runSyncJobBody(app, db));
  } catch (err) {
    await logError(app.client, "Sync job failed", err);
  } finally {
    syncRunning = false;
  }
}
