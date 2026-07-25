import { App, ReactionMessageItem } from "@slack/bolt";
import prisma from "../utils/prisma";

const reactionAddEvent = async (app: App): Promise<void> => {
  app.event("reaction_added", async ({ event, client }) => {
    if ((event.item as ReactionMessageItem).channel === "C028VGT0JMQ") return;
    if (event.reaction !== "star") return;
    if (event.item_user === event.user) return;

    let entry = await prisma.message.findFirst({
      where: {
        messageId: event.item["ts"],
      }
    });

    if (entry === null) {
      // Create the entry
      await prisma.message.create({
        data: {
          messageId: event.item["ts"],
          channelId: event.item["channel"],
          stars: 1,
        }
      });

      await prisma.appState.update({ where: { id: 1 }, data: { starsIncreased: { increment: 1 } } });

      return;
    }

    // Add the star
    entry = await prisma.message.update(
      {
        where: {
          messageId: event.item["ts"],
        },
        data: {
          stars: entry.stars + 1,
        }
      }
    );

    await prisma.appState.update({ where: { id: 1 }, data: { starsIncreased: { increment: 1 } } });

    if (entry.stars >= 5) {
      const recentEntries = await prisma.message.findMany({
        where: {
          channelId: event.item.channel,
          postedMessageId: {
            startsWith: "1"
          },
        },
        take: 5,
        orderBy: {
          postedMessageId: "desc"
        }
      });

      // cooldown! no more than 3 in the same channel in 5 minutes

      let count = 0;
      for (const recentEntry of recentEntries) {
        const time = new Date(Number(recentEntry.postedMessageId ?? 0));

        if (time.valueOf() > new Date().valueOf() - (1000 * 60 * 5)) {
          count++;
        }
      }

      if (count >= 3) {
        return;
      }

      const { permalink } = await client.chat.getPermalink({
        channel: event.item["channel"],
        message_ts: event.item["ts"],
      });

      if (entry.postedMessageId) {
        // Message already posted, so update
        const text = `⭐ *${entry.stars}*\n${permalink}`;

        await client.chat.update({
          channel: "C028VGT0JMQ",
          ts: entry.postedMessageId as string,
          text,
        });
      } else if (entry.announce) {
        // Post new message
        const message = `⭐ *${entry.stars}*\n${permalink}`;

        const posted = await client.chat.postMessage({
          channel: "C028VGT0JMQ",
          text: message,
        });

        await prisma.message.update(
          {
            where: {
              messageId: event.item["ts"],
            },
            data: {
              postedMessageId: posted.ts,
            }
          }
        );

        await prisma.appState.update({ where: { id: 1 }, data: { newPosts: { increment: 1 } } });
      }
      // else: announce === false means this entry was deliberately excluded
      // (backfilled historical data, or already surfaced via a review thread)
      // — never auto-post for it, even if it crosses the threshold again.
    }
  });
};

export default reactionAddEvent;
