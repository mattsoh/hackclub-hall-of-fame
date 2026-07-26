// Joins new public channels and offers an opt-out.

import type { App } from "@slack/bolt";
import { CHANNELS, RULES } from "../config";
import { log } from "../log";

const INTRO =
  `Hey! I'm Ninja Ten Thousand, and I keep an eye out for messages (${RULES.starThreshold}+ :star: reactions) ` +
  `worthy of the <#${CHANNELS.hallOfFame}>! If you'd like to opt out and remove me from the channel, just press ` +
  "the button. You can add me back at any time!";

export function registerChannelEvents(app: App): void {
  app.event("channel_created", async ({ event, client }) => {
    const channelId = event.channel.id;
    try {
      await client.conversations.join({ channel: channelId });
      await client.chat.postEphemeral({
        channel: channelId,
        user: event.channel.creator,
        text: INTRO,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: INTRO } },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Remove Me", emoji: true },
                value: "remove",
                action_id: "remove",
              },
            ],
          },
        ],
      });
    } catch (err) {
      log.warn(`Could not join or greet new channel <#${channelId}>`, err);
    }
  });

  app.action("remove", async ({ ack, body, client }) => {
    await ack();
    const channelId = (body as Record<string, any>).channel?.id as string | undefined;
    if (!channelId) return;
    try {
      // Public, not ephemeral: this opts the whole channel out, so everyone in
      // it needs to know the bot is gone and how to get it back — not just
      // whoever happened to press the button.
      await client.chat.postMessage({
        channel: channelId,
        text: "Leaving! Nothing from this channel will reach the hall of fame any more. Add me back any time with `/invite @Hall of Fame`.",
      });
      await client.conversations.leave({ channel: channelId });
    } catch (err) {
      log.warn(`Could not leave <#${channelId}> after opt-out`, err);
    }
  });
}
