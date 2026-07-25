import type { WebClient } from "@slack/web-api";

// Slack's reaction state is the only source of truth for star counts.
// Anything stored in the DB (or displayed in an announcement) is just a
// cached copy of this, and must be reconciled against it rather than
// derived by incrementing/decrementing the cache.
// The `error?: undefined` / `stars?: undefined` members are load-bearing: this
// project compiles with strictNullChecks off, and TypeScript won't narrow a
// discriminated union by its `ok` flag in that mode. Declaring both properties
// on both members keeps them reachable without a cast.
export type StarLookup =
  | { ok: true; stars: number; error?: undefined }
  | { ok: false; stars?: undefined; error: string };

export async function getLiveStarCount(
  client: WebClient,
  channel: string,
  ts: string
): Promise<StarLookup> {
  try {
    const res = await client.reactions.get({ channel, timestamp: ts });
    const message = res.message as Record<string, any> | undefined;
    const reactions = message?.reactions as Array<Record<string, any>> | undefined;
    const star = reactions?.find((r) => r.name === "star");
    if (!star) return { ok: true, stars: 0 };

    // A message's author starring their own post shouldn't help it qualify.
    // The reaction_added handlers already ignore the author's own event, but
    // that only stops it triggering a check — the count itself came straight
    // from Slack and included their star, so an author could still supply one
    // of the five.
    //
    // `count` is authoritative; `users` is truncated at 50 by Slack, so on a
    // message with more reactions than that the author may not be visible and
    // no adjustment is made. That only ever leaves the displayed number one
    // too high on posts far above the threshold, and never subtracts a star
    // that wasn't there.
    const author = message?.user as string | undefined;
    const authorStarred = Boolean(author && Array.isArray(star.users) && star.users.includes(author));
    return { ok: true, stars: Math.max(0, star.count - (authorStarred ? 1 : 0)) };
  } catch (err) {
    // Callers can't act on an individual failure, but the *reason* decides
    // whether a run's lookup errors are benign (the message was deleted) or a
    // real problem (the bot was removed from a channel, or we're still being
    // rate limited). Swallowing it silently, as this used to, made a 19%
    // failure rate impossible to diagnose from the logs.
    return { ok: false, error: describeSlackError(err) };
  }
}

// Slack's own error string ("not_in_channel"), else the WebClient's transport
// error code ("slack_webapi_rate_limited", "slack_webapi_request_error").
export function describeSlackError(err: unknown): string {
  const code = slackErrorCode(err);
  if (code) return code;
  const transport = (err as { code?: unknown } | undefined)?.code;
  if (typeof transport === "string") return transport;
  return "unknown";
}

// The `error` string Slack returns in a failed API response body, e.g.
// "cant_update_message". Bolt's WebClient throws a WebAPIPlatformError that
// carries the whole response under `.data`.
export function slackErrorCode(err: unknown): string | undefined {
  const data = (err as { data?: { error?: unknown } } | undefined)?.data;
  return typeof data?.error === "string" ? data.error : undefined;
}
