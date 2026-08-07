// Looks at one channel and reports which messages currently carry a star
// reaction, straight from Slack, and how each one compares to what the bot has
// recorded. This is the tool for "why isn't X in the hall of fame?".
//
// Shared by `/hof check` and `hof check` so the two can't drift apart — they
// were previously separate implementations with different thresholds and
// different page limits.

import type { WebClient } from "@slack/web-api";
import * as db from "./db";
import { CHANNELS, RULES, SCAN, TIMING } from "./config";
import { delay, fetchHistory, hasStar, permalinkOf, starCount, tsSeconds } from "./slack";
import { needsManualApproval, withinCatchUpWindow } from "./policy";

export interface Candidate {
  ts: string;
  stars: number;
}

export interface ScanResult {
  candidates: Candidate[];
  threadsChecked: number;
  truncated: boolean;
}

// Scans top-level messages and thread replies. Star counts are read straight
// off the message objects (conversations.history and .replies both embed a
// `reactions` array), so no extra reactions.get call is needed per message.
export async function scanChannel(client: WebClient, channelId: string, hours: number): Promise<ScanResult> {
  const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
  // A star can land on a reply to a much older parent, and
  // conversations.history only returns parents — so parents are fetched from
  // further back than the reporting window, and each one's `latest_reply` says
  // whether it is worth a conversations.replies call at all.
  const parentCutoff = cutoff - SCAN.threadParentScanDays * 24 * 3600;

  const { messages, truncated } = await fetchHistory(client, channelId, {
    oldest: parentCutoff,
    maxPages: SCAN.maxHistoryPagesPerChannel,
  });

  const candidates: Candidate[] = [];
  let threadsChecked = 0;
  let threadsSkipped = 0;

  for (const message of messages) {
    if (tsSeconds(message.ts) >= cutoff && hasStar(message)) {
      candidates.push({ ts: message.ts, stars: starCount(message) });
    }

    const latestReply = tsSeconds(message.latest_reply);
    if (!((message.reply_count ?? 0) > 0 && latestReply >= cutoff)) continue;
    if (threadsChecked >= SCAN.maxThreadFetchesPerChannel) {
      threadsSkipped++;
      continue;
    }

    threadsChecked++;
    await delay(TIMING.slackReadDelayMs);
    try {
      const replies = await client.conversations.replies({
        channel: channelId,
        ts: message.ts,
        oldest: String(cutoff),
      });
      for (const reply of (replies.messages as Record<string, any>[]) ?? []) {
        if (reply.ts === message.ts) continue; // the parent, handled above
        if (tsSeconds(reply.ts) < cutoff) continue;
        if (hasStar(reply)) candidates.push({ ts: reply.ts, stars: starCount(reply) });
      }
    } catch {
      threadsSkipped++;
    }
  }

  candidates.sort((a, b) => tsSeconds(b.ts) - tsSeconds(a.ts));
  // Either limit means the answer is incomplete, and saying "no starred
  // messages found" after silently skipping most of a channel is worse than
  // saying nothing.
  return { candidates, threadsChecked, truncated: truncated || threadsSkipped > 0 };
}

// One line per starred message, explaining its state in terms of the rules.
export async function explain(channelId: string, candidates: Candidate[]): Promise<string[]> {
  const rows = await db.rowsInChannel(channelId);
  const byId = new Map(rows.map((r) => [r.messageId, r]));

  return candidates.map((candidate) => {
    const link = permalinkOf(channelId, candidate.ts);
    const row = byId.get(candidate.ts);
    const live = `${candidate.stars}⭐ live`;

    if (!row) {
      return `${link} — ${live}, *not tracked* (no star event was ever recorded for this message)`;
    }

    const drift = row.stars !== candidate.stars ? ` (recorded ${row.stars}⭐)` : "";
    if (row.postedMessageId) return `${link} — ${live}${drift}, announced`;
    if (row.skip) return `${link} — ${live}${drift}, not announced (skipped — use \`hof unskip\` to allow)`;
    if (candidate.stars < RULES.starThreshold) {
      return `${link} — ${live}${drift}, below the ${RULES.starThreshold}⭐ threshold`;
    }
    if (row.approvalTs) {
      return `${link} — ${live}${drift}, *waiting for approval* (Post it / Never in <#${CHANNELS.log}>)`;
    }
    if (needsManualApproval(channelId)) {
      return (
        `${link} — ${live}${drift}, *qualifies, needs approval* ` +
        `(nothing from this channel posts on its own — it will be queued in <#${CHANNELS.log}>)`
      );
    }
    if (!withinCatchUpWindow(candidate.ts)) {
      return (
        `${link} — ${live}${drift}, *qualifies but too old to auto-post* ` +
        `(older than ${RULES.catchUpWindowHours}h; use \`hof post\` to announce it deliberately)`
      );
    }
    return `${link} — ${live}${drift}, *pending* (will be announced on the next reconcile)`;
  });
}
