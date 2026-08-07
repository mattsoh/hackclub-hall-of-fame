// The buttons on a held-for-approval message.
//
// A message gets held when posting it would exceed one of the two pace limits in
// RULES. Hitting a limit says nothing about the message itself — only that the
// channel is busy — so rather than dropping it, the bot asks. Either button
// resolves the request for good: the buttons are removed and the message is
// rewritten to record who decided what.

import type { App } from "@slack/bolt";
import * as db from "../db";
import { log } from "../log";
import { liveStars, permalinkOf } from "../slack";
import { APPROVE_ACTION, REJECT_ACTION, postAnnouncement, qualifies } from "../policy";

interface ActionBody {
  channel?: { id?: string };
  message?: { ts?: string };
  user?: { id?: string };
}

export function registerApprovalActions(app: App): void {
  // Rewrites the request message to its outcome, which also removes the buttons
  // so a decision can't be made twice.
  const resolve = async (body: ActionBody, text: string): Promise<void> => {
    const channel = body.channel?.id;
    const ts = body.message?.ts;
    if (!channel || !ts) return;
    try {
      await app.client.chat.update({ channel, ts, text, blocks: [] });
    } catch (err) {
      log.warn("Could not update an approval request message", err);
    }
  };

  app.action(APPROVE_ACTION, async ({ ack, body, action, client }) => {
    await ack();
    const messageId = (action as { value?: string }).value;
    const who = (body as ActionBody).user?.id;
    if (!messageId) return;

    try {
      const row = await db.getMessage(messageId);
      if (!row) {
        await resolve(body as ActionBody, ":question: That message is no longer tracked.");
        return;
      }
      if (row.postedMessageId) {
        await resolve(body as ActionBody, ":white_check_mark: Already announced.");
        await db.setApprovalTs(messageId, null);
        return;
      }

      // Re-checked rather than trusting the count in the request: stars may have
      // been removed while it sat in the queue, and nothing should ever be posted
      // on a number that wasn't confirmed against Slack.
      const live = await liveStars(client, row.channelId, row.messageId);
      const link = permalinkOf(row.channelId, row.messageId);
      if (!live.ok) {
        await resolve(body as ActionBody, `:warning: Couldn't read the reactions on ${link} (${live.error}) — not posted.`);
        return;
      }
      if (!qualifies(live.stars)) {
        await db.setApprovalTs(messageId, null);
        await resolve(
          body as ActionBody,
          `:x: ${link} is down to ${live.stars}⭐ and no longer qualifies — not posted.`
        );
        return;
      }

      // ignoreThrottle is the whole point: a human has just said to post it
      // despite the limit.
      const result = await postAnnouncement(client, row, live.stars, { ignoreThrottle: true });
      await db.setApprovalTs(messageId, null);
      await resolve(
        body as ActionBody,
        result.posted
          ? `:white_check_mark: Posted ${live.stars}⭐ ${link} — approved by <@${who}>.`
          : `:warning: Couldn't post ${link} (${result.reason}). It stays queued for the next reconcile.`
      );
    } catch (err) {
      log.error(`Approving ${messageId} failed`, err);
    }
  });

  app.action(REJECT_ACTION, async ({ ack, body, action }) => {
    await ack();
    const messageId = (action as { value?: string }).value;
    const who = (body as ActionBody).user?.id;
    if (!messageId) return;

    try {
      const row = await db.getMessage(messageId);
      if (!row) {
        await resolve(body as ActionBody, ":question: That message is no longer tracked.");
        return;
      }
      // skip is the permanent form of "no": it holds against the live handler
      // too, so a later star can't quietly bring this back.
      await db.setSkip(messageId, true);
      await db.setApprovalTs(messageId, null);
      const link = permalinkOf(row.channelId, row.messageId);
      await resolve(
        body as ActionBody,
        `:no_entry_sign: ${link} will not be announced — declined by <@${who}>. ` +
          `To undo: \`hof unskip ${link}\``
      );
    } catch (err) {
      log.error(`Rejecting ${messageId} failed`, err);
    }
  });
}
