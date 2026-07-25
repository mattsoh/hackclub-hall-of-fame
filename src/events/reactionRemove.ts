import { App, ReactionMessageItem } from "@slack/bolt";
import prisma from "../utils/prisma";

const reactionRemoveEvent = async (app: App): Promise<void> => {
  app.event("reaction_removed", async ({ event, client }) => {
    if ((event.item as ReactionMessageItem).channel === "C028VGT0JMQ") return;
    if (event.reaction !== "star") return;
    if (event.item_user === event.user) return;

    let entry = await prisma.message.findFirst({
      where: {
        messageId: event.item["ts"],
      },
    });

    if (entry === null) return;

    // Remove a star, if one can be removed
    if (entry.stars >= 1) {
      entry = await prisma.message.update(
        {
          where: {
            messageId: event.item["ts"],
          },
          data: {
            stars: entry.stars - 1,
          }
        }
      );

      await prisma.appState.update({ where: { id: 1 }, data: { starsDecreased: { increment: 1 } } });
    }

    if (entry.postedMessageId && entry.stars < 5) {
      await client.chat.delete({
        channel: "C028VGT0JMQ",
        ts: entry.postedMessageId as string,
      });

      await prisma.message.update(
        {
          where: {
            messageId: event.item["ts"],
          },
          data: {
            postedMessageId: "",
          }
        }
      );
    } else if (entry.postedMessageId) {
      const { permalink } = await client.chat.getPermalink({
        channel: event.item["channel"],
        message_ts: event.item["ts"],
      });

      const text = `⭐ *${entry.stars}*\n${permalink}`;

      await client.chat.update({
        channel: "C028VGT0JMQ",
        ts: entry.postedMessageId as string,
        text,
      });
    }
  });
};

export default reactionRemoveEvent;
