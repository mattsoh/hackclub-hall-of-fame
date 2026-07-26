// Keeps the hall of fame honest when messages disappear. Neither case was
// handled before: deleting a starred message left its announcement in the
// channel forever pointing at a dead permalink, and deleting an announcement by
// hand was silently undone by the next star reaction on its origin.

import type { App } from "@slack/bolt";
import * as db from "../db";
import { CHANNELS } from "../config";
import { log } from "../log";
import { permalinkOf } from "../slack";
import { deleteAnnouncement, wasSelfDeleted } from "../policy";

export function registerMessageEvents(app: App): void {
  app.event("message", async ({ event, client }) => {
    const message = event as Record<string, any>;
    if (message.subtype !== "message_deleted") return;

    const channel = message.channel as string | undefined;
    const deletedTs = message.deleted_ts as string | undefined;
    if (!channel || !deletedTs) return;

    try {
      if (channel === CHANNELS.hallOfFame) {
        // The bot's own cleanup (a message dropping below the threshold) also
        // arrives here, and must not be mistaken for a moderator's decision.
        if (wasSelfDeleted(deletedTs)) return;

        const row = await db.getByPostedId(deletedTs);
        if (!row) return;

        await db.clearPosted(row.messageId);
        await db.setSkip(row.messageId, true);
        log.info(
          `An announcement was deleted by hand — ${permalinkOf(row.channelId, row.messageId)} will not be ` +
            "reposted. Run `hof unskip <link>` to allow it again."
        );
        return;
      }

      // The starred message itself was deleted: its announcement now links to
      // nothing, so it goes too.
      const row = await db.getMessage(deletedTs);
      if (!row) return;
      if (row.postedMessageId) {
        await deleteAnnouncement(client, row, "the original message was deleted");
      }
      await db.deleteMessage(deletedTs);
    } catch (err) {
      log.error(`message_deleted handling failed for ${channel}/${deletedTs}`, err);
    }
  });
}
