// The rules, and the only three functions that write to #hall-of-fame.
//
// Every posting path goes through postAnnouncement, so the star threshold, the
// author-star exclusion and the 3-per-channel burst limit are applied
// identically whether the trigger was a live reaction, a reconcile catch-up or
// a hand-run CLI command. Previously there were five posting paths: two of them
// applied the burst limit, two of them excluded the author's own star, and they
// wrote three different values for the `announce` flag.

import type { WebClient } from "@slack/web-api";
import * as db from "./db";
import { CHANNELS, RULES, SCAN, TIMING } from "./config";
import { announcementText, ageHours, delay, describeError, isPermanent, permalinkFor } from "./slack";
import { log } from "./log";

export function qualifies(stars: number): boolean {
  return stars >= RULES.starThreshold;
}

// Outside this window a message is not re-checked and never posted. Its star
// count stopped moving long ago.
export function tooOldToTrack(ts: string): boolean {
  return ageHours(ts) > SCAN.maxMessageAgeDays * 24;
}

// The anti-spam rule for anything the bot MISSED. The live handler has no such
// limit — a star landing on an old message today is a real, organic
// hall-of-fame entry and should be posted. But a message that qualified while
// the bot was down, and is now older than this, is history: it gets recorded
// with its true count and left alone. This is what stops a restart replaying a
// backlog into the channel.
export function withinCatchUpWindow(ts: string): boolean {
  return ageHours(ts) <= RULES.catchUpWindowHours;
}

// The burst limit: no more than RULES.maxPostsPerChannel announcements from one
// channel inside RULES.burstWindowMinutes, so one busy channel can't take over
// the feed.
export async function channelHasRoom(channelId: string): Promise<boolean> {
  const since = Math.floor(Date.now() / 1000) - RULES.burstWindowMinutes * 60;
  const recent = await db.postsInChannelSince(channelId, since);
  return recent < RULES.maxPostsPerChannel;
}

// The `ts?: undefined` / `reason?: undefined` members are load-bearing: this
// project compiles with strictNullChecks off, and TypeScript will not narrow a
// discriminated union by its flag in that mode. Declaring both properties on
// both members keeps them reachable without a cast.
export type PostResult =
  | { posted: true; ts: string; reason?: undefined }
  | { posted: false; ts?: undefined; reason: "claimed" | "throttled" | "skipped" | "failed" };

// Posts a new announcement for an origin message. Safe to call concurrently for
// the same message: the row is claimed first, so of two simultaneous callers
// exactly one posts and the other gets `claimed`.
export async function postAnnouncement(
  client: WebClient,
  row: { messageId: string; channelId: string; skip?: boolean },
  stars: number,
  opts: { ignoreThrottle?: boolean } = {}
): Promise<PostResult> {
  if (row.skip) return { posted: false, reason: "skipped" };

  if (!opts.ignoreThrottle && !(await channelHasRoom(row.channelId))) {
    // Deliberately left as-is: still unposted, still eligible, so the next
    // star event or reconcile run picks it up rather than losing it. The old
    // code dropped throttled entries into a permanent hold-back, which
    // systematically destroyed the overflow from exactly the busiest channels.
    log.progress(`throttled: ${row.channelId}/${row.messageId} — ${RULES.maxPostsPerChannel} posts already in the last ${RULES.burstWindowMinutes}m`);
    return { posted: false, reason: "throttled" };
  }

  if (!(await db.claimForPost(row.messageId, TIMING.claimTtlMs))) {
    return { posted: false, reason: "claimed" };
  }

  // Outside the try: permalinkFor never throws (it falls back to a hand-built
  // link), so an origin-side problem can't be mistaken for a posting failure.
  const permalink = await permalinkFor(client, row.channelId, row.messageId);

  let ts: string | undefined;
  try {
    const posted = await client.chat.postMessage({
      channel: CHANNELS.hallOfFame,
      text: announcementText(stars, permalink),
      unfurl_links: true,
    });
    ts = posted.ts as string | undefined;
  } catch (err) {
    await db.releaseClaim(row.messageId).catch(() => undefined);
    log.error(`Failed to announce ${permalink} (${stars}⭐)`, err);
    return { posted: false, reason: "failed" };
  }

  if (!ts) {
    // Nothing to record, so the row goes back to unposted rather than looking
    // handled while nothing is in the channel.
    await db.releaseClaim(row.messageId).catch(() => undefined);
    log.error(`Slack accepted the announcement for ${permalink} but returned no timestamp — not recorded`);
    return { posted: false, reason: "failed" };
  }

  // The announcement now exists in the channel, so failing to write it down is
  // what produces duplicates — the next star event would post a second copy.
  // Retried rather than abandoned, and if it still fails the timestamp is logged
  // so it can be recorded by hand. (The next reconcile also recovers it, by
  // reading the channel and recording announcements with no row.)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await db.setPosted(row.messageId, ts);
      log.info(`Announced ${stars}⭐ ${permalink}`);
      return { posted: true, ts };
    } catch (err) {
      if (attempt === 3) {
        log.error(
          `Announced ${permalink} as ${ts} but could not record it in the database. The next reconcile will ` +
            "pick it up from the channel; until then a new star on that message could post a duplicate.",
          err
        );
        return { posted: true, ts };
      }
      await delay(500 * attempt);
    }
  }
  return { posted: true, ts };
}

// Refreshes the star count shown on an existing announcement. Never gated on
// the burst limit or on `skip` — the announcement already exists, and keeping
// its number honest is the whole point of the reconciler.
export async function updateAnnouncement(
  client: WebClient,
  row: { messageId: string; channelId: string; postedMessageId: string | null },
  stars: number
): Promise<"updated" | "gone" | "failed"> {
  const permalink = await permalinkFor(client, row.channelId, row.messageId);
  try {
    await client.chat.update({
      channel: CHANNELS.hallOfFame,
      ts: row.postedMessageId as string,
      text: announcementText(stars, permalink),
    });
    return "updated";
  } catch (err) {
    if (isPermanent(err)) {
      // The announcement is gone, or was posted by an earlier installation of
      // this app and cannot be edited with this token. Either way retrying is
      // pointless. Clear the link so it stops failing on every future star
      // event; whether it should be re-posted is then decided by the age rule,
      // not by a stale column.
      await db.clearPosted(row.messageId);
      return "gone";
    }
    // Transient (rate limit, network, Slack outage). Leave the row alone so the
    // next run sees the same mismatch and retries.
    log.warn(`Could not update announcement for ${permalink}: ${describeError(err)}`);
    return "failed";
  }
}

// Announcement timestamps this process deleted on purpose. The message_deleted
// handler treats a deleted announcement as a moderator overruling the bot, so it
// has to be able to tell that case apart from the bot's own cleanup — otherwise
// dropping below the threshold would also mark the message as skipped.
const selfDeleted = new Map<string, number>();

export function wasSelfDeleted(ts: string): boolean {
  const at = selfDeleted.get(ts);
  return at !== undefined && Date.now() - at < 5 * 60 * 1000;
}

// Removes an announcement whose origin no longer qualifies (or no longer
// exists). The link is cleared only once the message is actually gone — the old
// handler cleared it even when the delete failed transiently, orphaning an
// announcement in the channel with nothing left pointing at it.
export async function deleteAnnouncement(
  client: WebClient,
  row: { messageId: string; postedMessageId: string | null },
  reason: string
): Promise<boolean> {
  if (row.postedMessageId) {
    selfDeleted.set(row.postedMessageId, Date.now());
    for (const [ts, at] of selfDeleted) {
      if (Date.now() - at > 5 * 60 * 1000) selfDeleted.delete(ts);
    }
  }
  try {
    await client.chat.delete({ channel: CHANNELS.hallOfFame, ts: row.postedMessageId as string });
  } catch (err) {
    if (!isPermanent(err)) {
      log.warn(`Could not delete announcement ${row.postedMessageId} (${reason})`, err);
      return false;
    }
    // Already gone — that is the state we wanted anyway.
  }
  await db.clearPosted(row.messageId);
  log.info(`Removed announcement for ${row.messageId} — ${reason}`);
  return true;
}
