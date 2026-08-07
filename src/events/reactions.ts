// The live path: a star reaction lands, and the hall of fame reacts to it.
//
// Slack's reaction state is the only source of truth, so both handlers read the
// live count rather than adjusting the stored one. The author's own star is
// excluded by starCount() in slack.ts, which is why neither handler bails out on
// `item_user === user` any more: ignoring the author's event stopped a check from
// happening but did nothing about the count itself, and it meant an author's star
// arriving after the bot restarted could leave a qualifying message unexamined.

import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import * as db from "../db";
import { BLACKLISTED_CHANNELS, CHANNELS, RULES } from "../config";
import { log } from "../log";
import { liveStars, permalinkOf } from "../slack";
import { deleteAnnouncement, postAnnouncement, qualifies, updateAnnouncement } from "../policy";

interface StarEvent {
  channel: string;
  ts: string;
}

// Star reactions on real messages outside #hall-of-fame itself.
//
// The item.type check is the one that was missing: a reaction on a file or a
// file comment has no `ts`, and the old handlers read item["ts"] regardless —
// which then went into a findFirst with an undefined key and matched an
// arbitrary row. The shape is described inline rather than imported from Bolt,
// whose exported name for it has changed between minor versions.
function starTarget(event: { reaction: string; item: unknown }): StarEvent | undefined {
  if (event.reaction !== "star") return undefined;
  const item = event.item as { type?: string; channel?: string; ts?: string } | undefined;
  if (item?.type !== "message") return undefined;
  if (!item.channel || !item.ts) return undefined;
  if (item.channel === CHANNELS.hallOfFame) return undefined;
  if (BLACKLISTED_CHANNELS.has(item.channel)) return undefined;
  return { channel: item.channel, ts: item.ts };
}

async function refreshStars(
  client: WebClient,
  target: StarEvent
): Promise<{ row: db.MessageRow; stars: number; changed: boolean } | undefined> {
  const live = await liveStars(client, target.channel, target.ts);
  if (!live.ok) {
    log.progress(`star event ignored for ${target.channel}/${target.ts}: could not read reactions (${live.error})`);
    return undefined;
  }
  const before = await db.getMessage(target.ts);
  const row = await db.recordStars(target.ts, target.channel, live.stars);
  return { row, stars: live.stars, changed: !before || before.stars !== live.stars };
}

export function registerReactionEvents(app: App): void {
  app.event("reaction_added", async ({ event, client }) => {
    const target = starTarget(event);
    if (!target) return;

    try {
      const state = await refreshStars(client, target);
      if (!state) return;
      const { row, stars, changed } = state;

      // An announcement already exists: keep its number honest. This is not a
      // new post, so it is not gated on the burst limit or on `skip`, and it is
      // handled before either of those could suppress it.
      if (row.postedMessageId) {
        if (changed) await updateAnnouncement(client, row, stars);
        return;
      }

      if (!qualifies(stars)) return;

      // No age limit here, deliberately. A star landing on an old message today
      // is an organic, real hall-of-fame entry — it's the reconciler, which
      // looks at what the bot MISSED, that refuses to replay old backlogs.
      await postAnnouncement(client, row, stars);
    } catch (err) {
      log.error(`reaction_added failed for ${permalinkOf(target.channel, target.ts)}`, err);
    }
  });

  app.event("reaction_removed", async ({ event, client }) => {
    const target = starTarget(event);
    if (!target) return;

    try {
      // Records the row even if there wasn't one, so a message whose stars are
      // being removed still ends up tracked. The old handler returned early when
      // no row existed, which left any announcement without a row frozen at a
      // stale count forever.
      const state = await refreshStars(client, target);
      if (!state) return;
      const { row, stars, changed } = state;

      if (!row.postedMessageId) return;

      if (!qualifies(stars)) {
        await deleteAnnouncement(
          client,
          row,
          `dropped to ${stars}⭐, below the ${RULES.starThreshold}⭐ threshold`
        );
        return;
      }
      if (changed) await updateAnnouncement(client, row, stars);
    } catch (err) {
      log.error(`reaction_removed failed for ${permalinkOf(target.channel, target.ts)}`, err);
    }
  });
}
