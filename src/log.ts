// The only logger. Everything — the live handlers, the reconciler, the CLI —
// logs through this, so there is exactly one place that decides what reaches
// the console, what reaches Slack, and what pings a human.
//
// Replaces a module where every call site had to pass a WebClient as its first
// argument (36 of them, two of which passed the wrong one), where a `ping`
// positional boolean meant a fully successful reconcile @-mentioned a human,
// and where a single repeating per-event failure produced one @-mention per
// star reaction with no throttle of any kind.
//
// Three rules hold everywhere:
//   1. Only log.error pings, and repeats inside the dedupe window don't.
//   2. Slack writes are queued and paced, so the logger can't rate-limit
//      itself and can't block a handler waiting on Slack.
//   3. Nothing here ever throws. A broken logger must not break the bot.

import type { WebClient } from "@slack/web-api";
import { ADMIN_USER, CHANNELS, LOGGING } from "./config";

type Level = "info" | "warn" | "error";

interface QueuedPost {
  text: string;
  threadTs?: string;
  // Resolved with the posted message's ts, so a caller that wants to thread
  // detail under its summary can await just that one post.
  resolve: (ts: string | undefined) => void;
}

let slack: WebClient | undefined;
// Off until initLog runs, so importing this module from the CLI (which has no
// business posting to the team's log channel) is inert by default.
let slackEnabled = false;

const queue: QueuedPost[] = [];
let draining = false;

// message signature -> when it was last posted to Slack, and how many
// occurrences have been swallowed since.
const recent = new Map<string, { at: number; suppressed: number }>();

function now(): number {
  return Date.now();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stamp(level: Level, text: string): string {
  return `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${text}`;
}

// Slack rejects oversized messages, and postLog used to swallow that failure —
// so an unbounded list of sent announcements silently lost the whole summary,
// and the audit thread that was supposed to follow it never appeared either.
function clamp(text: string): string {
  if (text.length <= LOGGING.maxMessageChars) return text;
  return `${text.slice(0, LOGGING.maxMessageChars)}\n… truncated (${text.length} chars)`;
}

// Drains the queue one message at a time with a fixed gap between writes. Runs
// as a detached loop: callers hand a message over and move on.
async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift() as QueuedPost;
      let ts: string | undefined;
      try {
        const res = await slack?.chat.postMessage({
          channel: CHANNELS.log,
          text: item.text,
          thread_ts: item.threadTs,
          // Long summaries embed permalinks to origin messages; unfurling every
          // one of them turns a summary into a screenful.
          unfurl_links: false,
        });
        ts = res?.ts as string | undefined;
      } catch (err) {
        console.error(stamp("error", `logger: failed to post to Slack: ${safeString(err)}`));
      }
      item.resolve(ts);
      if (queue.length > 0) await delay(LOGGING.postSpacingMs);
    }
  } finally {
    draining = false;
  }
}

function enqueue(text: string, threadTs?: string): Promise<string | undefined> {
  if (!slackEnabled || !slack) return Promise.resolve(undefined);
  return new Promise<string | undefined>((resolve) => {
    queue.push({ text: clamp(text), threadTs, resolve });
    void drain();
  });
}

// Never throws, whatever it is handed — including an object whose toString or
// getters throw, which the previous logger would have rejected on from outside
// any try/catch, re-entering itself through the unhandledRejection handler.
function safeString(value: unknown): string {
  try {
    if (value instanceof Error) return value.stack ?? value.message;
    if (typeof value === "string") return value;
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "<unprintable>";
  }
}

// True if this message should go to Slack now. Deduping is keyed on the
// caller's message text only, deliberately excluding the error detail: the same
// failure recurring with a slightly different stack or timestamp is still the
// same failure, and keying on the detail would let it through every time.
function shouldPost(level: Level, message: string): { post: boolean; suppressed: number } {
  const key = `${level}:${message}`;
  const seen = recent.get(key);
  if (seen && now() - seen.at < LOGGING.dedupeWindowMs) {
    seen.suppressed++;
    return { post: false, suppressed: seen.suppressed };
  }
  const suppressed = seen?.suppressed ?? 0;
  recent.set(key, { at: now(), suppressed: 0 });

  // Bounded so a long-running process can't accumulate entries forever.
  if (recent.size > 500) {
    for (const [k, v] of recent) {
      if (now() - v.at >= LOGGING.dedupeWindowMs) recent.delete(k);
    }
  }
  return { post: true, suppressed };
}

function emit(level: Level, message: string, detail?: unknown): Promise<string | undefined> {
  const detailText = detail === undefined ? "" : safeString(detail);
  console[level === "info" ? "log" : level](stamp(level, message + (detailText ? `\n${detailText}` : "")));

  const { post, suppressed } = shouldPost(level, message);
  if (!post) return Promise.resolve(undefined);

  const icon = level === "error" ? ":rotating_light: " : level === "warn" ? ":warning: " : "";
  // Only errors ping, and only the first one in the window — a systemic
  // failure now costs one @-mention per 15 minutes rather than one per event.
  const ping = level === "error" ? `<@${ADMIN_USER}> ` : "";
  const repeat = suppressed > 0 ? `\n_(${suppressed} identical message(s) suppressed in the last ${Math.round(LOGGING.dedupeWindowMs / 60000)} minutes)_` : "";
  const body = detailText ? `\n\`\`\`${detailText}\`\`\`` : "";

  return enqueue(`${ping}${icon}${message}${body}${repeat}`);
}

export const log = {
  // Turns Slack posting on and gives the logger its client. Until this is
  // called (the CLI never calls it) logging is console-only.
  init(client: WebClient): void {
    slack = client;
    slackEnabled = true;
  },

  info(message: string): void {
    void emit("info", message);
  },

  warn(message: string, detail?: unknown): void {
    void emit("warn", message, detail);
  },

  error(message: string, detail?: unknown): void {
    void emit("error", message, detail);
  },

  // Console only. For the per-item chatter of a long job — a reconcile run
  // does thousands of these, and none of them belong in a Slack channel.
  // The old job posted 10-13 Slack messages per run, five of them contentless
  // narration, and none during the 25 minutes where progress actually happened.
  progress(message: string): void {
    console.log(stamp("info", message));
  },

  // A summary plus its supporting detail: one Slack message, with the detail
  // as threaded replies so an arbitrarily long list can't blow the message
  // size limit or bury the channel.
  async report(message: string, details: string[] = []): Promise<void> {
    console.log(stamp("info", [message, ...details].join("\n")));
    if (!slackEnabled) return;
    const parentTs = await enqueue(message);
    if (!parentTs || details.length === 0) return;

    const perMessage = 40;
    for (let i = 0; i < details.length; i += perMessage) {
      await enqueue(details.slice(i, i + perMessage).join("\n"), parentTs);
    }
  },

  // Awaits the queue. Called before a deliberate exit so the message that
  // caused the exit isn't lost with the process. Polls rather than awaiting
  // drain() directly: drain() returns immediately when a drain is already in
  // flight, so awaiting it would return without having flushed anything.
  async flush(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    void drain();
    while ((queue.length > 0 || draining) && Date.now() < deadline) {
      await delay(50);
    }
  },
};
