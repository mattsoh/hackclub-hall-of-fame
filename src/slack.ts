// Everything that talks to Slack or interprets what Slack returns. The star
// count rule lives here because it is a fact about how to read a Slack
// message; what to *do* with the resulting number is in policy.ts.

import type { WebClient } from "@slack/web-api";
import { ANNOUNCEABLE_SUBTYPES, SCAN, TIMING } from "./config";

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Slack timestamps are "<unix seconds>.<microseconds>".
export function tsSeconds(ts: string | null | undefined): number {
  return Number((ts ?? "").split(".")[0]) || 0;
}

export function ageHours(ts: string): number {
  return (Date.now() / 1000 - tsSeconds(ts)) / 3600;
}

const PERMALINK = /archives\/([A-Z0-9]+)\/p(\d+)/;

// The inverse of Slack's permalink format: the 16-digit run after "p" is the
// ts with its dot removed, and the fractional part is always 6 digits. Three
// of the old scripts each split this differently, so a ts could round-trip
// into a different message depending on which file parsed it.
export function parsePermalink(text: string): { channel: string; ts: string } | null {
  const match = PERMALINK.exec(text || "");
  if (!match) return null;
  const [, channel, digits] = match;
  if (digits.length <= 6) return null;
  return { channel, ts: `${digits.slice(0, -6)}.${digits.slice(-6)}` };
}

// Hand-built permalink. Correct for a top-level message, but for a thread
// reply Slack's own permalink carries a `?thread_ts=…&cid=…` suffix that opens
// the thread rather than dropping the reader at a bare reply — so prefer
// permalinkFor() wherever an extra API call is affordable.
export function permalinkOf(channel: string, ts: string): string {
  return `https://hackclub.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
}

export async function permalinkFor(client: WebClient, channel: string, ts: string): Promise<string> {
  try {
    const res = await client.chat.getPermalink({ channel, message_ts: ts });
    return (res.permalink as string) || permalinkOf(channel, ts);
  } catch {
    // A permalink we build ourselves is still a working link to the message;
    // failing the whole announcement over it would be worse.
    return permalinkOf(channel, ts);
  }
}

// The one announcement format. Matched by ANNOUNCEMENT_STARS when reading the
// channel back, so the writer and the reader can't drift apart.
export function announcementText(stars: number, permalink: string): string {
  return `⭐ *${stars}*\n${permalink}`;
}

export const ANNOUNCEMENT_STARS = /^(?:⭐|:star:) \*(\d+)\*/;

// System events (joins, permission changes, pins) are reactable but nobody
// wrote them, so they can never be hall-of-fame material. A channel called
// #hall-of-fame-fraud farmed entries by starring "has joined the channel"
// messages, which qualified because nothing looked at the subtype.
export function isAnnounceable(message: Record<string, any> | undefined): boolean {
  const subtype = message?.subtype as string | undefined;
  if (!subtype) return true;
  return ANNOUNCEABLE_SUBTYPES.has(subtype);
}

// A message's author starring their own post must not help it qualify. The
// reaction handlers already ignore the author's own event, but that only stops
// it triggering a check — the count itself comes straight from Slack and
// includes their star, so without this an author could supply one of the five.
//
// `count` is authoritative; `users` is what identifies the author's star.
// Slack truncates `users` at 50 unless the call asked for the full list, which
// is why every reactions.get here passes full: true. On a message read from
// conversations.history (where the list is always truncated and no `full`
// option exists) a message with 50+ stars may not show the author — which only
// ever leaves the number one too high on a post far above the threshold, and
// never subtracts a star that wasn't there.
//
// The subtype gate lives here rather than in each caller because every path
// reads its counts through this function — live handler, reconciler and
// channel scanner all inherit it, and an already-posted announcement whose
// origin turns out to be a system event now reads zero and is cleaned up on
// the next reconcile.
export function starCount(message: Record<string, any> | undefined): number {
  if (!isAnnounceable(message)) return 0;
  if (!isAnnounceable(message)) return 0;
  const reactions = message?.reactions as Array<Record<string, any>> | undefined;
  const star = reactions?.find((r) => r.name === "star");
  if (!star) return 0;
  const author = message?.user as string | undefined;
  const authorStarred = Boolean(author && Array.isArray(star.users) && star.users.includes(author));
  return Math.max(0, Number(star.count ?? 0) - (authorStarred ? 1 : 0));
}

export function hasStar(message: Record<string, any> | undefined): boolean {
  const reactions = message?.reactions as Array<Record<string, any>> | undefined;
  return Boolean(reactions?.some((r) => r.name === "star"));
}

export type StarLookup = { ok: true; stars: number; error?: undefined } | { ok: false; stars?: undefined; error: string };

// Slack's reaction state is the only source of truth for star counts. Anything
// in the database is a cached copy to be reconciled against this, never
// something to derive by incrementing.
export async function liveStars(client: WebClient, channel: string, ts: string): Promise<StarLookup> {
  try {
    const res = await client.reactions.get({ channel, timestamp: ts, full: true });
    return { ok: true, stars: starCount(res.message as Record<string, any> | undefined) };
  } catch (err) {
    // Callers can't act on an individual failure, but the reason decides
    // whether a run's lookup errors are benign (the message was deleted) or a
    // real problem (the bot was removed from a channel, or we are still rate
    // limited). Swallowing it silently made a 19% failure rate impossible to
    // diagnose from the logs.
    return { ok: false, error: describeError(err) };
  }
}

// The `error` string in a failed Slack response body, e.g. "cant_update_message".
// Bolt's WebClient throws a WebAPIPlatformError carrying the response under `.data`.
export function errorCode(err: unknown): string | undefined {
  const data = (err as { data?: { error?: unknown } } | undefined)?.data;
  return typeof data?.error === "string" ? data.error : undefined;
}

// Slack's own error string, else the transport error code
// ("slack_webapi_rate_limited", "slack_webapi_request_error").
export function describeError(err: unknown): string {
  const code = errorCode(err);
  if (code) return code;
  const transport = (err as { code?: unknown } | undefined)?.code;
  return typeof transport === "string" ? transport : "unknown";
}

// Errors that will never succeed on a retry: the message was deleted, its
// channel is gone, or it was posted by a different app installation that this
// token cannot edit.
export const PERMANENT_ERRORS = new Set(["cant_update_message", "message_not_found", "channel_not_found"]);

export function isPermanent(err: unknown): boolean {
  const code = errorCode(err);
  return Boolean(code && PERMANENT_ERRORS.has(code));
}

// Full channel history, paced and page-capped. `truncated` is returned rather
// than ignored: the old job paginated without a cap and without checking
// whether it had finished, so a partial fetch silently turned every unseen
// announcement into a "deleted from Slack" conclusion.
export async function fetchHistory(
  client: WebClient,
  channel: string,
  opts: { oldest?: number; maxPages: number } = { maxPages: SCAN.maxHistoryPages }
): Promise<{ messages: Record<string, any>[]; truncated: boolean }> {
  const messages: Record<string, any>[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const res = await client.conversations.history({
      channel,
      cursor,
      limit: 200,
      ...(opts.oldest ? { oldest: String(opts.oldest) } : {}),
    });
    messages.push(...((res.messages as Record<string, any>[]) ?? []));
    cursor = res.response_metadata?.next_cursor || undefined;
    pages++;
    if (cursor && pages < opts.maxPages) await delay(TIMING.slackReadDelayMs);
  } while (cursor && pages < opts.maxPages);

  return { messages, truncated: Boolean(cursor) };
}
