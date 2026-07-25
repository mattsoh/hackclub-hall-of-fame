import type { WebClient } from "@slack/web-api";

// Slack's reaction state is the only source of truth for star counts.
// Anything stored in the DB (or displayed in an announcement) is just a
// cached copy of this, and must be reconciled against it rather than
// derived by incrementing/decrementing the cache.
export async function getLiveStarCount(
  client: WebClient,
  channel: string,
  ts: string
): Promise<{ ok: true; stars: number } | { ok: false }> {
  try {
    const res = await client.reactions.get({ channel, timestamp: ts });
    const reactions = (res.message as Record<string, any> | undefined)?.reactions as Array<Record<string, any>> | undefined;
    const star = reactions?.find((r) => r.name === "star");
    return { ok: true, stars: star ? star.count : 0 };
  } catch {
    return { ok: false };
  }
}
