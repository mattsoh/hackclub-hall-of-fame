import { App, ReactionMessageItem } from "@slack/bolt";
import prisma from "../utils/prisma";
import { getLiveStarCount } from "../utils/stars";

const reactionAddEvent = async (app: App): Promise<void> => {
  app.event("reaction_added", async ({ event, client }) => {
    if ((event.item as ReactionMessageItem).channel === "C028VGT0JMQ") return;
    if (event.reaction !== "star") return;
    if (event.item_user === event.user) return;

    const liveCount = await getLiveStarCount(client, event.item["channel"], event.item["ts"]);
    if (!liveCount.ok) return;

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
          stars: liveCount.stars,
        }
      });

      await prisma.appState.update({ where: { id: 1 }, data: { starsIncreased: { increment: 1 } } });

      return;
    }

    // Set the star count to Slack's live count — the only source of truth.
    entry = await prisma.message.update(
      {
        where: {
          messageId: event.item["ts"],
        },
        data: {
          stars: liveCount.stars,
        }
      }
    );

    await prisma.appState.update({ where: { id: 1 }, data: { starsIncreased: { increment: 1 } } });

    if (entry.stars < 5) return;

    // Refreshing the star count on an announcement that already exists is not
    // a new post: it doesn't consume the channel cooldown, isn't gated on
    // `announce`, and never changes that flag. Handled before either of those
    // checks so neither can suppress an update.
    if (entry.postedMessageId) {
      const { permalink } = await client.chat.getPermalink({
        channel: event.item["channel"],
        message_ts: event.item["ts"],
      });

      await client.chat.update({
        channel: "C028VGT0JMQ",
        ts: entry.postedMessageId as string,
        text: `⭐ *${entry.stars}*\n${permalink}`,
      });
      return;
    }

    // announce === false means this entry was deliberately excluded
    // (backfilled historical data, or already surfaced via a review thread)
    // — never auto-post for it, even if it crosses the threshold again.
    if (!entry.announce) return;

    // cooldown! no more than 3 in the same channel in 5 minutes
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

    let count = 0;
    for (const recentEntry of recentEntries) {
      // postedMessageId is a Slack ts — seconds, not milliseconds. Reading it
      // as milliseconds put every comparison in January 1970, so the count
      // never rose above zero and this limit has never actually fired.
      const time = new Date(Number(recentEntry.postedMessageId ?? 0) * 1000);

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

    const posted = await client.chat.postMessage({
      channel: "C028VGT0JMQ",
      text: `⭐ *${entry.stars}*\n${permalink}`,
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
  });
};

export default reactionAddEvent;
