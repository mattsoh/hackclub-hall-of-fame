import { App } from "@slack/bolt";
import prisma from "../utils/prisma";
import { starCountFromMessage } from "../utils/stars";
import { logError, logInfo } from "../utils/log";

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
// A star reaction can land on a thread reply whose parent is much older than
// the window (a reply to a message from last month, starred today). history
// alone can't see that — Slack only returns thread parents from
// conversations.history, not their replies — so parents are scanned this far
// back, and a thread's `latest_reply` tells us whether it's worth a
// conversations.replies call at all.
const THREAD_SCAN_DAYS = 30;
// conversations.history/replies are Tier 3 (~50/min); paced to stay under it.
const CALL_DELAY_MS = 1250;
const MAX_HISTORY_PAGES = 5;
// Bounds how many threads get a conversations.replies call per run — a
// channel with a large recent backlog of active threads shouldn't turn one
// command into a multi-minute scan.
const MAX_THREAD_FETCHES = 20;

function tsSeconds(ts: string): number {
  return Number((ts ?? "").split(".")[0]) || 0;
}

function originLink(channel: string, ts: string): string {
  return `https://hackclub.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Candidate {
  ts: string;
  stars: number;
}

// Scans both top-level messages and thread replies for the window, reading
// star counts straight off the message objects Slack returns (both
// conversations.history and conversations.replies embed a `reactions` array
// inline, so no separate reactions.get call is needed per message). Returns
// only messages that currently carry a star reaction — this is a live view of
// Slack, independent of whatever the DB does or doesn't have recorded.
async function scanForStarredMessages(
  client: any,
  channelId: string,
  cutoff: number
): Promise<{ candidates: Candidate[]; threadsChecked: number; truncated: boolean }> {
  const threadScanCutoff = cutoff - THREAD_SCAN_DAYS * 24 * 60 * 60;
  const topLevel: Record<string, any>[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const res = await client.conversations.history({
      channel: channelId,
      oldest: String(threadScanCutoff),
      cursor,
      limit: 200,
    });
    topLevel.push(...((res.messages as Record<string, any>[]) ?? []));
    cursor = res.response_metadata?.next_cursor;
    pages++;
    if (cursor && pages < MAX_HISTORY_PAGES) await delay(CALL_DELAY_MS);
  } while (cursor && pages < MAX_HISTORY_PAGES);

  const candidates: Candidate[] = [];
  let threadsChecked = 0;

  for (const message of topLevel) {
    if (tsSeconds(message.ts) >= cutoff) {
      const stars = starCountFromMessage(message);
      if (stars > 0 || message.reactions?.some((r: Record<string, any>) => r.name === "star")) {
        candidates.push({ ts: message.ts, stars });
      }
    }

    const latestReply = message.latest_reply ? tsSeconds(message.latest_reply) : 0;
    const hasRecentReply = (message.reply_count ?? 0) > 0 && latestReply >= cutoff;
    if (!hasRecentReply || threadsChecked >= MAX_THREAD_FETCHES) continue;

    threadsChecked++;
    await delay(CALL_DELAY_MS);
    const repliesRes = await client.conversations.replies({
      channel: channelId,
      ts: message.ts,
      oldest: String(cutoff),
    });
    for (const reply of (repliesRes.messages as Record<string, any>[]) ?? []) {
      if (reply.ts === message.ts) continue; // the parent, already handled above
      if (tsSeconds(reply.ts) < cutoff) continue;
      const stars = starCountFromMessage(reply);
      if (stars > 0 || reply.reactions?.some((r: Record<string, any>) => r.name === "star")) {
        candidates.push({ ts: reply.ts, stars });
      }
    }
  }

  return { candidates, threadsChecked, truncated: pages >= MAX_HISTORY_PAGES && Boolean(cursor) };
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
        text: "Usage: `/ninja-check <#channel-or-channel-id>` — shows starred messages (including thread replies) "
          + `from that channel in the last ${WINDOW_HOURS} hours, live from Slack.`,
      });
      return;
    }

    // logInfo posts to both the log channel and the console (see utils/log.ts).
    await logInfo(app.client, `/ninja-check run by <@${command.user_id}> for <#${channelId}> (last ${WINDOW_HOURS}h)`);

    try {
      const cutoff = Math.floor(Date.now() / 1000) - WINDOW_HOURS * 60 * 60;
      const { candidates, threadsChecked, truncated } = await scanForStarredMessages(client, channelId, cutoff);

      if (candidates.length === 0) {
        await logInfo(
          app.client,
          `/ninja-check: no starred messages found live in <#${channelId}> in the last ${WINDOW_HOURS} hours ` +
            `(checked ${threadsChecked} active thread(s)).`
        );
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: `No starred messages found live in <#${channelId}> in the last ${WINDOW_HOURS} hours ` +
            `(checked top-level messages and ${threadsChecked} active thread(s)).`,
        });
        return;
      }

      candidates.sort((a, b) => tsSeconds(b.ts) - tsSeconds(a.ts));

      const dbRows = await prisma.message.findMany({ where: { channelId } });
      const dbByMessageId = new Map(dbRows.map((r) => [r.messageId, r]));

      const lines: string[] = [];
      for (const candidate of candidates) {
        const row = dbByMessageId.get(candidate.ts);

        if (!row) {
          // Live star exists but reaction_added never created a row for it —
          // this is the actual signal that star tracking missed something.
          lines.push(
            `${originLink(channelId, candidate.ts)} — ${candidate.stars}⭐ live, ` +
              "*not tracked in DB* — reaction_added likely never fired/recorded for this message"
          );
          continue;
        }

        const posted = row.postedMessageId ? "posted" : "not posted";
        const eligible = row.announce && row.stars >= STAR_THRESHOLD && !row.postedMessageId;
        let note = "";
        if (eligible) note = ", *eligible to post*";
        else if (!row.announce) note = " (announce=false, held back)";
        else if (row.stars < STAR_THRESHOLD) note = ", below threshold";

        const drifted = row.stars !== candidate.stars ? ` (DB cached ${row.stars}⭐, drifted)` : "";
        lines.push(
          `${originLink(channelId, candidate.ts)} — ${candidate.stars}⭐ live${drifted}, ${posted}${note}`
        );
      }

      if (truncated) {
        lines.push(`… channel history truncated at ${MAX_HISTORY_PAGES} pages — some older activity may be missing.`);
      }

      const header =
        `Starred messages live in <#${channelId}> in the last ${WINDOW_HOURS} hours (${candidates.length}, ` +
        `${threadsChecked} active thread(s) checked):`;
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `${header}\n${lines.join("\n")}`,
      });

      await logInfo(
        app.client,
        `/ninja-check: found ${candidates.length} starred message(s) live in <#${channelId}>, ` +
          `${threadsChecked} active thread(s) checked.`
      );
    } catch (e) {
      await logError(app.client, `/ninja-check failed for <#${channelId}>`, e);
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Something went wrong looking that up — check the logs.",
      });
    }
  });
};

export default checkCommand;
