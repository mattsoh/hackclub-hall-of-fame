import { WebClient } from "@slack/web-api";

export const LOG_CHANNEL = "C0AR0NB4UQ1";
const ERROR_PING_USER = "U07DPHQCCCS";

export async function postLog(client: WebClient, text: string, ping = false): Promise<string | undefined> {
  const message = ping ? `<@${ERROR_PING_USER}> ${text}` : text;

  try {
    const result = await client.chat.postMessage({
      channel: LOG_CHANNEL,
      text: message,
    });
    return result.ts as string | undefined;
  } catch (e) {
    // The logger must never crash the app or cause a failure loop.
    console.error("Failed to post log message to Slack:", e);
    console.log(message);
    return undefined;
  }
}

export async function logError(client: WebClient, message: string, error?: unknown): Promise<void> {
  let detail = "";
  if (error instanceof Error) {
    detail = `\n\`\`\`${error.stack ?? error.message}\`\`\``;
  } else if (error !== undefined) {
    detail = `\n\`\`\`${String(error)}\`\`\``;
  }

  await postLog(client, `:rotating_light: ${message}${detail}`, true);
}

export async function logInfo(client: WebClient, message: string): Promise<void> {
  await postLog(client, message, false);
}
