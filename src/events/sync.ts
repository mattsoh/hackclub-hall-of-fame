import { App } from "@slack/bolt";
import { runSyncJob } from "../jobs/sync";
import { logError, logInfo } from "../utils/log";

// Same restriction as /ninja-check — this triggers real posts to
// #hall-of-fame, so it isn't meant to be discoverable or usable elsewhere.
const ALLOWED_CHANNEL = "C0AR0NB4UQ1";

let running = false;

const syncCommand = async (app: App): Promise<void> => {
  app.command("/ninja-sync", async ({ command, ack, client }) => {
    await ack();

    if (command.channel_id !== ALLOWED_CHANNEL) return;

    if (running) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "A sync job is already running — check the logs for its progress.",
      });
      return;
    }

    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: "Starting sync job — progress and results will be posted here.",
    });
    await logInfo(app.client, `/ninja-sync run by <@${command.user_id}>`);

    running = true;
    try {
      await runSyncJob(app);
    } catch (err) {
      await logError(app.client, "/ninja-sync failed", err);
    } finally {
      running = false;
    }
  });
};

export default syncCommand;
