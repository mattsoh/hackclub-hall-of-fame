import { App } from "@slack/bolt";
import { withPgClient } from "../utils/pg";
import { logError, logInfo } from "../utils/log";

interface AppStateRow {
  starsIncreased: number;
  starsDecreased: number;
  newPosts: number;
  statsWindowStart: Date;
}

export async function runDailyOverview(app: App): Promise<void> {
  try {
    await withPgClient(async (db) => {
      const res = await db.query<AppStateRow>(
        `SELECT "starsIncreased", "starsDecreased", "newPosts", "statsWindowStart" FROM "AppState" WHERE id = 1`
      );
      const state = res.rows[0];
      if (!state) return;

      const windowStart = new Date(state.statsWindowStart).toISOString().replace("T", " ").slice(0, 16) + " UTC";

      await logInfo(
        app.client,
        `Daily overview (since ${windowStart}):\n` +
          `- stars increased: ${state.starsIncreased}\n` +
          `- stars decreased: ${state.starsDecreased}\n` +
          `- new posts in #hall-of-fame: ${state.newPosts}`
      );

      await db.query(
        `UPDATE "AppState" SET "starsIncreased" = 0, "starsDecreased" = 0, "newPosts" = 0, "statsWindowStart" = now() WHERE id = 1`
      );
    });
  } catch (err) {
    await logError(app.client, "Daily overview job failed", err);
  }
}
