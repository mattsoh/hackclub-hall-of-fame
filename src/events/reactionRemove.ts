import { App, ReactionMessageItem } from "@slack/bolt";
import prisma from "../utils/prisma";
import { getLiveStarCount, slackErrorCode, PERMANENT_UPDATE_ERRORS } from "../utils/stars";
import { logError, logInfo } from "../utils/log";

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

    const liveCount = await getLiveStarCount(client, event.item["channel"], event.item["ts"]);
    if (!liveCount.ok) return;

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

    await prisma.appState.update({ where: { id: 1 }, data: { starsDecreased: { increment: 1 } } });

    if (entry.postedMessageId && entry.stars < 5) {
      try {
        await client.chat.delete({
          channel: "C028VGT0JMQ",
          ts: entry.postedMessageId as string,
        });
      } catch (err) {
        const code = slackErrorCode(err);
        // Already gone is fine — that's the state we wanted anyway. Anything
        // else is worth knowing about, but shouldn't block clearing the link.
        if (!code || !PERMANENT_UPDATE_ERRORS.has(code)) {
          await logError(
            app.client,
            `reaction_removed: failed to delete announcement — origin ${event.item["channel"]}:${event.item["ts"]}, ` +
              `announcement C028VGT0JMQ:${entry.postedMessageId}`,
            err
          );
        }
      }

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
      try {
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
      } catch (err) {
        const code = slackErrorCode(err);
        if (code && PERMANENT_UPDATE_ERRORS.has(code)) {
          await prisma.message.update({
            where: { messageId: event.item["ts"] },
            data: { postedMessageId: "" },
          });
        } else {
          await logError(
            app.client,
            `reaction_removed: failed to update announcement — origin ${event.item["channel"]}:${event.item["ts"]}, ` +
              `announcement C028VGT0JMQ:${entry.postedMessageId}`,
            err
          );
        }
      }
    }
  });
};

export default reactionRemoveEvent;
