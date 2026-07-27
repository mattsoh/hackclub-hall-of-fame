import { App, ExpressReceiver } from "@slack/bolt";
import { PORT, TIMING, requireEnv } from "./config";
import * as db from "./db";
import { log } from "./log";
import { registerApprovalActions } from "./events/approvals";
import { registerChannelEvents } from "./events/channel";
import { registerCommands } from "./events/commands";
import { registerMessageEvents } from "./events/messages";
import { registerReactionEvents } from "./events/reactions";
import { dueForRun, reconcile } from "./reconcile";

requireEnv(["SLACK_BOLT_SIGNING_SECRET", "SLACK_BOLT_TOKEN", "DATABASE_URL"]);

const receiver = new ExpressReceiver({ signingSecret: process.env.SLACK_BOLT_SIGNING_SECRET as string });
const app = new App({ token: process.env.SLACK_BOLT_TOKEN as string, receiver });

log.init(app.client);

app.error(async (error) => {
  log.error("Unhandled Bolt error", error);
});

// An uncaught exception leaves the process in an undefined state, so it used to
// be logged and swallowed — and because the logger pinged on every error with no
// throttle, a recurring synchronous throw pinged a human forever while the bot
// sat there broken. Now the platform gets to restart it, and the message that
// caused the exit is flushed to Slack first rather than dying with the process.
async function die(kind: string, reason: unknown): Promise<void> {
  log.error(`${kind} — shutting down so the process can be restarted`, reason);
  await log.flush().catch(() => undefined);
  process.exit(1);
}
process.on("uncaughtException", (err) => void die("Uncaught exception", err));

// Rejections are logged but NOT fatal, deliberately. The App constructor's
// token-verification call rejects outside any catchable scope on a known,
// benign failure mode, and normal request handling is unaffected by it — making
// that fatal would turn it into a crash loop. The reason it was worth
// swallowing before and is worth swallowing now is different, though: the
// logger's dedupe means a repeating rejection costs one @-mention per 15
// minutes instead of one per occurrence.
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled promise rejection", reason);
});

receiver.app.get("/", async (_req, res) => {
  const ok = await db.ping();
  res
    .status(200)
    .type("text/plain")
    .send(`hi, this is Hack Club's hall of fame\ndatabase: ${ok ? "connected" : "unavailable"}`);
});

// A real health check. This used to return 200 unconditionally, so an instance
// whose database was unreachable — and the database is load-bearing for every
// function this bot has — looked healthy forever and was never restarted.
receiver.app.get("/status", async (_req, res) => {
  const ok = await db.ping();
  res.status(ok ? 200 : 503).type("text/plain").send(ok ? "ok" : "database unavailable");
});

async function main(): Promise<void> {
  await db.initSchema();

  // Registered before the server accepts anything. Previously start() ran first,
  // with an awaited Slack log post between it and the registrations, so every
  // event that arrived in that window was silently dropped.
  registerReactionEvents(app);
  registerMessageEvents(app);
  registerChannelEvents(app);
  registerCommands(app);
  registerApprovalActions(app);

  await app.start(PORT);
  log.info(`Hall of Fame started on port ${PORT}.`);

  // On boot, reconcile only if one is actually due. The interval is stored in the
  // database rather than in memory, so restarts don't reset it — production saw
  // 12 restarts in 4 hours, each of which kicked off a full scan when this ran
  // unconditionally. Together with the catch-up window and the per-run cap, that
  // is what stops a restart replaying a backlog into the channel.
  if (await dueForRun()) {
    log.info("A reconcile is due — starting one.");
    void reconcile(app);
  }
  setInterval(() => {
    void (async () => {
      if (await dueForRun()) await reconcile(app);
    })();
  }, TIMING.reconcileIntervalMs);
}

void main().catch((err) => die("Startup failed", err));
