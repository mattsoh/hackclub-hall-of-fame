// The "is this thing working?" view, shared by `/hof status` and `hof status`.

import * as db from "./db";
import { RULES, SCAN, TIMING } from "./config";

function ago(at: Date | null): string {
  if (!at) return "never";
  const minutes = Math.round((Date.now() - new Date(at).getTime()) / 60000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)} days ago`;
}

export async function statusLines(): Promise<string[]> {
  const counts = await db.counts(RULES.starThreshold);
  const { lastReconcileAt } = await db.getState();
  const awaitingApproval = await db.pendingApprovals();

  return [
    "*Hall of Fame status*",
    `• tracked messages: ${counts.tracked} (${counts.posted} announced, ${counts.unposted} not)`,
    `• at or above ${RULES.starThreshold}⭐ and not announced: ${counts.atThreshold}`,
    `• skipped by hand or by moderation: ${counts.skipped}`,
    `• last reconcile: ${ago(lastReconcileAt)} (runs every ${Math.round(TIMING.reconcileIntervalMs / 3600000)}h)`,
    `• rules: ${RULES.starThreshold}⭐ threshold, the author's own star never counts`,
    `• pace: at most ${RULES.maxPerHour} posts per hour overall, and ${RULES.maxPerChannelPerDay} per channel ` +
      "per day — anything over a limit is queued for approval here rather than dropped",
    `• always queued for approval, however many stars: ${
      RULES.manualApprovalChannels.length > 0
        ? RULES.manualApprovalChannels.map((id) => `<#${id}>`).join(", ")
        : "no channels"
    }`,
    `• waiting for approval right now: ${awaitingApproval}`,
    `• catch-up: only messages younger than ${RULES.catchUpWindowHours}h are auto-posted by a reconcile, ` +
      `at most ${RULES.maxCatchUpPostsPerRun} per run — so a restart can't replay a backlog`,
    `• messages older than ${SCAN.maxMessageAgeDays} days are not tracked at all`,
  ];
}
