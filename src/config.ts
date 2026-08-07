// Every constant and every environment variable this project reads, in one
// place. Previously the hall-of-fame channel id was written out in eight
// files, the 5-star threshold in six, and each of the eight scripts in
// scripts/ carried its own copy of the pacing delays — so "change the
// threshold" meant grepping for the literal 5 and hoping.

import * as dotenv from "dotenv";

dotenv.config();

export const CHANNELS = {
  hallOfFame: "C028VGT0JMQ",
  // Where the bot's own logs go, and the only channel its admin command works
  // in — it surfaces internal state and can trigger real posts, so it isn't
  // meant to be discoverable elsewhere.
  log: "C0AR0NB4UQ1",
};

// Pinged on errors. Not a display name anywhere — only ever used as <@id>.
export const ADMIN_USER = "U07DPHQCCCS";

// The name the announcement bot posts under. Matched by name rather than
// bot_id because the app's bot_id changed when it was reinstalled, so both
// B028V7JBD5H (2021-2024) and B06LLPAFP09 (2024-present) are legitimately us.
export const BOT_NAME = "Hall of Fame";

export const RULES = {
  // Stars needed to reach #hall-of-fame. The author's own star never counts
  // toward this — see starCount() in policy.ts.
  starThreshold: 5,

  // Two rate limits on #hall-of-fame itself. Both count by *when the
  // announcement was posted*, never by how old the starred message is — the
  // point is to pace the channel's own feed, so a message from last week and one
  // from a minute ago consume the limit identically.
  //
  // Nothing is discarded for hitting a limit. The message is queued for approval
  // in the log channel with Approve / Never buttons instead, so the decision is
  // a human's rather than a silent drop. See requestApproval() in policy.ts.
  maxPerHour: 3, // across the whole channel, all origins
  maxPerChannelPerDay: 10, // per origin channel

  // Backstop on the approval queue. A pathological burst should ask a human a
  // few times and then stop asking, not fill the log channel with buttons —
  // whatever is left stays unposted and the next reconcile finds it again.
  maxPendingApprovals: 20,

  // The anti-restart-spam rule, and the reason it is an age test rather than a
  // stored flag. The live handler posts a qualifying message whenever it sees
  // one, however old — an organic late star is a real hall-of-fame entry. But
  // the reconciler, which by definition looks at things the bot MISSED, only
  // posts an origin younger than this. Anything older is recorded with its
  // true star count and simply not posted.
  //
  // Because that decision is re-derived from the message's timestamp on every
  // run, it never has to be written down, so it can never be written down
  // wrongly. The old code stored it as `announce = false`, which meant that
  // noticing a message had been missed was itself what disqualified it from
  // ever being posted — so every outage became a permanent loss.
  catchUpWindowHours: 24,

  // Ceiling on how many messages one reconcile run will deal with at all —
  // posted plus queued for approval. Stops a run that finds a large backlog from
  // turning it into a large pile of buttons. Whatever is left over is untouched
  // and still eligible next run.
  maxCatchUpPostsPerRun: 10,
};

export const TIMING = {
  // reactions.get, conversations.history and conversations.replies are all
  // Slack Tier 3 (~50 requests/minute). 1250ms keeps us just under that.
  // Going faster does not help: the earlier 200ms pacing spent most of its
  // time in Bolt's 10-second 429 backoff and made no better progress, it just
  // produced a wall of rate-limit warnings while doing so.
  slackReadDelayMs: 1250,
  // chat.postMessage is about one message per second per channel.
  slackPostDelayMs: 1200,

  // How often the reconciler runs, and the guard that stops a restart from
  // triggering one: on boot it runs only if this long has passed since the
  // last completed run, which is recorded in the database rather than in
  // memory. Production saw 12 restarts in 4 hours, each kicking off a full
  // scan under the old run-sync-on-startup behaviour.
  reconcileIntervalMs: 6 * 60 * 60 * 1000,

  // A row is claimed just before its announcement is posted, so two concurrent
  // star events can't both post it. If the process dies mid-post the claim is
  // never released, so it expires on its own after this long.
  claimTtlMs: 2 * 60 * 1000,
};

export const SCAN = {
  // Messages this recent have their live star count re-checked on every
  // reconcile run — this is where counts actually still move. Older ones are
  // covered by a rotating slice so the whole window gets reconciled over
  // several runs without any single run taking hours.
  alwaysRecheckDays: 7,
  // Beyond this age a message is left alone entirely. Its star count stopped
  // moving long ago, and posting a year-old message to #hall-of-fame isn't
  // wanted regardless.
  maxMessageAgeDays: 365,
  // Ceiling on reactions.get calls per reconcile run — a hard cap on the whole
  // phase, not just on the older slice. At Tier 3 pacing this bounds the star
  // check at roughly 17 minutes. There is no bulk reactions API, so a run
  // cannot check every tracked message.
  maxStarChecksPerRun: 800,

  // Safety valve on paginating #hall-of-fame. The channel holds ~8,100
  // messages (41 pages), so this is generous; it exists so a pagination bug
  // can't loop forever. A run that actually hits it says so, rather than
  // silently drawing "missing from Slack" conclusions from a partial fetch.
  maxHistoryPages: 100,

  // Per-channel limits when scanning one channel for starred messages
  // (`hof check` / `/hof check`). A starred thread reply is a real
  // hall-of-fame entry — the most recent announcement at time of writing is
  // one — but conversations.history only returns thread parents, so finding
  // them costs an extra conversations.replies call per active thread.
  maxHistoryPagesPerChannel: 3,
  maxThreadFetchesPerChannel: 15,
  // Default reporting window for `hof check` / `/hof check`.
  checkWindowHours: 12,
  // How far back to look for thread parents whose replies might be recent: a
  // star can land on a reply to a months-old message.
  threadParentScanDays: 30,
};

export const LOGGING = {
  // How often the star-check loop reports progress into the run's thread. At 800
  // checks that's 8 updates — enough to see it moving, few enough that the
  // thread stays readable.
  starCheckReportEvery: 100,
  // Identical messages inside this window are counted rather than re-posted.
  // Production logged the same message_not_found six times in seven minutes,
  // pinging a human each time.
  dedupeWindowMs: 15 * 60 * 1000,
  // Minimum spacing between Slack writes from the logger, so a burst can't
  // rate-limit the logger itself.
  postSpacingMs: 1100,
  // Slack rejects messages over 40,000 characters; keep well clear.
  maxMessageChars: 3500,
};

// Mirroring the *content* of a message the bot acts on into the log channel.
//
// #hall-of-fame only ever gets `⭐ N` and a permalink, and a good share of
// origins are private channels — the bot is a member of those too, and nothing
// in the rules excludes them. So an announcement is frequently a link that the
// reader cannot open, and an approval request asks a human to decide about a
// message they cannot see. Both are fixed by putting the text in the log
// channel.
//
// The log channel and nowhere else, deliberately. It is private, it already
// carries the bot's internal state, and #hall-of-fame keeps its bare-permalink
// format so this never widens who can read an origin message.
export const FORWARD = {
  // FORWARD_TO_LOG=false turns it off without a code change.
  enabled: process.env.FORWARD_TO_LOG !== "false",
  // Longest rendering of one message's content. Slack's limit is far higher;
  // this is about the log channel staying readable.
  maxContentChars: 1200,
  // Emailed-in and snippet files carry their whole body inline in the file
  // object, so they need their own cap before the overall one.
  maxFileTextChars: 500,
};

export const PORT = Number(process.env.PORT) || 3000;

// Checked all at once at boot so a fresh deployment reports everything that is
// missing in one go, rather than failing on the first one at some random later
// moment.
export function requireEnv(names: string[]): void {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        "Copy .env.example to .env and fill it in."
    );
  }
}
