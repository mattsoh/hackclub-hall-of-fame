// Everything that talks to Slack or interprets what Slack returns. The star
// count rule lives here because it is a fact about how to read a Slack
// message; what to *do* with the resulting number is in policy.ts.

import type { WebClient } from "@slack/web-api";
import { SCAN, TIMING } from "./config";

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
export function starCount(message: Record<string, any> | undefined): number {
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

// Broadcast mentions have to be defused before any user-authored text is
// re-posted anywhere. Forwarding a message that contains <!channel> verbatim
// would @-mention everyone in the destination channel, once per forward — the
// bot would be turning other people's pings into its own.
//
// `<@U…>` and `<#C…>` are deliberately left alone: they render as the person's
// or channel's name, which is most of what makes a forwarded message readable,
// and Slack does not notify someone about a private channel they aren't in.
const BROADCAST = /<!(channel|here|everyone)(\|[^>]*)?>/g;
const SUBTEAM = /<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g;
// Any other special <!…> token (date, link with a label, etc). Keeping the
// label and dropping the directive is lossless for reading purposes.
const OTHER_SPECIAL = /<!([^>|]+)(?:\|([^>]*))?>/g;

export function defuseMentions(text: string): string {
  return (text ?? "")
    .replace(BROADCAST, (_match, name: string) => `@${name}`)
    .replace(SUBTEAM, (_match, handle: string) => handle || "@group")
    .replace(OTHER_SPECIAL, (_match, token: string, label: string) => label || token);
}

function truncate(text: string, max: number): string {
  const trimmed = (text ?? "").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}…`;
}

// Renders one file the way it needs to be read rather than the way Slack
// returns it. An emailed-in message — which is how a surprising number of real
// hall-of-fame entries arrive — has an empty `text` and carries its entire body
// in files[0].plain_text, so listing the filename alone would describe the
// message as blank.
function describeFile(file: Record<string, any>, maxChars: number): string {
  const title = (file?.title as string) || (file?.name as string) || "untitled";
  const kind = (file?.pretty_type as string) || (file?.filetype as string) || "file";
  const head = `:paperclip: *${title}* (${kind})`;

  const body = (file?.plain_text as string) || (file?.preview_plain_text as string) || "";
  if (!body.trim()) return head;
  return `${head}\n${quote(truncate(defuseMentions(body), maxChars))}`;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

// What a message actually says, as text safe to re-post.
//
// `text` alone is not enough: it is empty for an emailed-in message (body in
// `files`), and empty for most app-posted messages (body in `attachments`).
// Reading only `text` renders a lot of genuinely starred messages as nothing at
// all, which is the specific failure this is here to avoid.
export function messageContent(
  message: Record<string, any> | undefined,
  opts: { maxChars: number; maxFileChars: number }
): string {
  if (!message) return "_(could not read the message — it may have been deleted)_";

  const parts: string[] = [];

  const text = defuseMentions((message.text as string) || "").trim();
  if (text) parts.push(quote(text));

  for (const file of (message.files as Record<string, any>[]) ?? []) {
    parts.push(describeFile(file, opts.maxFileChars));
  }

  // Attachment `text`/`fallback` is where an app's real content lives. Skipped
  // when it only repeats what `text` already said, which link unfurls do.
  for (const attachment of (message.attachments as Record<string, any>[]) ?? []) {
    const body = defuseMentions((attachment?.text as string) || (attachment?.fallback as string) || "").trim();
    if (!body || text.includes(body)) continue;
    parts.push(quote(truncate(body, opts.maxFileChars)));
  }

  if (parts.length === 0) return "_(no text — the message is probably an unsupported attachment type)_";
  return truncate(parts.join("\n"), opts.maxChars);
}

// One message, by channel and ts, whatever kind of message it is.
//
// reactions.get is the primary because it is the only single call that works
// for a thread reply as well as a top-level message — conversations.history
// does not return replies at all, which is the same gap the scanner has to work
// around. It needs the message to actually carry a reaction; every caller here
// is looking at a starred message, and the fallback covers the case where the
// last star was removed in between.
export async function fetchMessage(
  client: WebClient,
  channel: string,
  ts: string
): Promise<Record<string, any> | undefined> {
  try {
    const res = await client.reactions.get({ channel, timestamp: ts, full: true });
    if (res.message) return res.message as Record<string, any>;
  } catch {
    // Fall through — no_reaction is expected, anything else is covered below.
  }

  // conversations.replies accepts the ts of any message in a thread, including
  // a reply's own, so this covers both shapes too.
  try {
    const res = await client.conversations.replies({ channel, ts, limit: 1, inclusive: true });
    const found = ((res.messages as Record<string, any>[]) ?? []).find((m) => m?.ts === ts);
    if (found) return found;
  } catch {
    // Deleted, or the bot is no longer in the channel. Callers render the
    // undefined case rather than failing.
  }
  return undefined;
}

export interface ChannelInfo {
  name: string;
  isPrivate: boolean;
}

// Cached for the process's lifetime: a channel's name and privacy do change,
// but not on a timescale that matters for labelling a log line, and this is
// called on the live announcement path.
const channelCache = new Map<string, ChannelInfo>();

export async function channelInfo(client: WebClient, channel: string): Promise<ChannelInfo | undefined> {
  const cached = channelCache.get(channel);
  if (cached) return cached;
  try {
    const res = await client.conversations.info({ channel });
    const info: ChannelInfo = {
      name: ((res.channel as Record<string, any>)?.name as string) || channel,
      isPrivate: Boolean((res.channel as Record<string, any>)?.is_private),
    };
    channelCache.set(channel, info);
    return info;
  } catch {
    return undefined;
  }
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
