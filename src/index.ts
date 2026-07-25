import * as dotenv from "dotenv";
import { App, ExpressReceiver } from "@slack/bolt";
import * as events from "./events/index";
import prisma from "./utils/prisma";
import { logError } from "./utils/log";
import { runSyncJob } from "./jobs/sync";
import { runDailyOverview } from "./jobs/dailyOverview";

dotenv.config();

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const expressReceiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_BOLT_SIGNING_SECRET,
});
export const app = new App({
  token: process.env.SLACK_BOLT_TOKEN,
  receiver: expressReceiver,
});

app.error(async (error) => {
  await logError(app.client, "Unhandled Bolt error", error);
});

// Catches failures outside Bolt's own listener error handling (e.g. the
// App constructor's token-verification call, which runs before any of Bolt's
// own error wrapping exists). Logging and continuing is safer than crashing:
// normal request handling is unaffected by that specific known failure mode.
process.on("unhandledRejection", (reason) => {
  logError(app.client, "Unhandled promise rejection", reason).catch(() => {
    console.error("Unhandled promise rejection (and failed to log it):", reason);
  });
});
process.on("uncaughtException", (err) => {
  logError(app.client, "Uncaught exception", err).catch(() => {
    console.error("Uncaught exception (and failed to log it):", err);
  });
});
expressReceiver.app.get("/", async (req, res) => {
  let dbStatus = "connected";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    dbStatus = "unavailable";
  }
  res
    .status(200)
    .type("text/plain")
    .send(`hi, this is Hack Club's hall of fame\ndatabase: ${dbStatus}`);
});

expressReceiver.app.get("/status", (req, res) => {
  res.status(200).send();
});

(async (): Promise<void> => {
  await app.start(Number(process.env.PORT) || 3000);
  console.log("Server started!");

  // credits to Rishi (https://github.com/rishiosaur) for this
  for (const [event, handler] of Object.entries(events)) {
    handler(app);
    console.log(`Loaded event: ${event}`);
  }

  runSyncJob(app).catch((err) => logError(app.client, "Initial sync job failed", err));
  setInterval(() => {
    runSyncJob(app).catch((err) => logError(app.client, "Scheduled sync job failed", err));
  }, ONE_DAY_MS);

  setInterval(() => {
    runDailyOverview(app).catch((err) => logError(app.client, "Daily overview failed", err));
  }, ONE_DAY_MS);
})();
