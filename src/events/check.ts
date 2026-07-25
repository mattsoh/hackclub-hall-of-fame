import { App } from "@slack/bolt";
import prisma from "../utils/prisma";
import { getLiveStarCount } from "../utils/stars";
import { logError } from "../utils/log";

// Matches either a raw channel ID or Slack's auto-linked "<#C123|name>" form,
// which is what command.text contains when the invoker used the channel
// picker/autocomplete instead of pasting a bare ID.
const CHANNEL_ID = /^<#([A-Z0-9]+)(?:\|[^>]*)?>$|^([A-Z0-9]+)$/;

// Restricted to this channel only — the command surfaces internal tracking
// state (live vs. cached star counts, hold-back reasons) that isn't meant to
// be discoverable or usable from anywhere else.
const ALLOWED_CHANNEL = "C0AR0NB4UQ1";

const WINDOW_HOURS = 12;
const STAR_THRESHOLD = 5;
// Live reactions.get is Tier 3 and this runs synchronously in response to a
// user command — bounded so a channel with an unusually large recent backlog
// can't turn one /check into a long rate-limited chain.
const MAX_LIVE_CHECKS = 25;

function tsSeconds(ts: string): number {
  return Number(ts.split(".")[0]) || 0;
}

function originLink(channel: string, ts: string): string {
  return `https://hackclub.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
}

const checkCommand = async (app: App): Promise<void> => {
  app.command("/ninja-check", async ({ command, ack, client }) => {
    await ack();

    // Silently no-op outside the allowed channel — no ephemeral response, so
    // the command's existence isn't revealed anywhere else.
    if (command.channel_id !== ALLOWED_CHANNEL) return;

    const match = CHANNEL_ID.exec(command.text.trim());
    const channelId = match?.[1] ?? match?.[2];
    if (!channelId) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Usage: `/ninja-check <#channel-or-channel-id>` — shows tracked star events for that channel from the last "
          + `${WINDOW_HOURS} hours.`,
      });
      return;
    }

    try {
      const cutoff = Math.floor(Date.now() / 1000) - WINDOW_HOURS * 60 * 60;
      const rows = (await prisma.message.findMany({ where: { channelId } }))
        .filter((r) => tsSeconds(r.messageId) >= cutoff)
        .sort((a, b) => tsSeconds(b.messageId) - tsSeconds(a.messageId));

      if (rows.length === 0) {
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: `No tracked star events for <#${channelId}> in the last ${WINDOW_HOURS} hours. `
            + "That means no reaction_added event for a :star: has been recorded there — worth checking the bot "
            + "is actually in that channel if one was expected.",
        });
        return;
      }

      const toLiveCheck = rows.slice(0, MAX_LIVE_CHECKS);
      const lines: string[] = [];
      for (const row of toLiveCheck) {
        const live = await getLiveStarCount(client, channelId, row.messageId);
        const liveStr = live.ok ? `${live.stars}⭐ live` : `live check failed (${live.error})`;
        const posted = row.postedMessageId ? "posted" : "not posted";
        const eligible = row.announce && row.stars >= STAR_THRESHOLD && !row.postedMessageId;

        let note = "";
        if (eligible) note = ", *eligible to post*";
        else if (!row.announce) note = " (announce=false, held back)";
        else if (row.stars < STAR_THRESHOLD) note = ", below threshold";

        lines.push(`${originLink(channelId, row.messageId)} — ${row.stars}⭐ cached, ${liveStr}, ${posted}${note}`);
      }
      if (rows.length > toLiveCheck.length) {
        lines.push(`… and ${rows.length - toLiveCheck.length} more (not live-checked, oldest in the window)`);
      }

      const header = `Tracked star events for <#${channelId}> in the last ${WINDOW_HOURS} hours (${rows.length}):`;
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `${header}\n${lines.join("\n")}`,
      });
    } catch (e) {
      await logError(app.client, "/check command failed", e);
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Something went wrong looking that up — check the logs.",
      });
    }
  });
};

export default checkCommand;
