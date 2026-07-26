// The admin slash command. `/hof <verb>` is the real interface; `/ninja-check`
// and `/ninja-sync` are kept as aliases because those are the commands actually
// registered in the Slack app, and renaming a slash command there is a separate
// job from this one.
//
// Everything here is restricted to the log channel: it surfaces internal state
// and can trigger real posts, so it isn't meant to be discoverable elsewhere.

import type { App } from "@slack/bolt";
import { CHANNELS, RULES, SCAN } from "../config";
import { log } from "../log";
import { reconcile, isRunning } from "../reconcile";
import { explain, scanChannel } from "../scan";
import { statusLines } from "../status";

// Either a bare channel id or Slack's auto-linked "<#C123|name>" form, which is
// what the text contains when the invoker used the channel picker.
const CHANNEL_REF = /^<#([A-Z0-9]+)(?:\|[^>]*)?>$|^([A-Z0-9]+)$/;

const USAGE = [
  "*`/hof`*",
  "• `/hof status` — counts, when the last reconcile ran, and the rules in force",
  "• `/hof check <#channel>` — every starred message in that channel right now, and why each is or isn't announced",
  "• `/hof reconcile` — fix drifted star counts and post anything genuinely missed",
].join("\n");

type Respond = (message: string) => Promise<unknown>;

async function doCheck(app: App, text: string, respond: Respond): Promise<void> {
  const trimmed = text.trim();
  const match = CHANNEL_REF.exec(trimmed);
  const channelId = match?.[1] ?? match?.[2];
  if (!channelId) {
    // A bare "#name" means Slack sent the text unescaped, which carries no
    // channel id to look anything up with. Worth saying explicitly — the fix is
    // a checkbox in the app's slash command settings, not anything the invoker
    // did wrong.
    const looksUnescaped = trimmed.startsWith("#");
    await respond(
      "Usage: `/hof check <#channel>`" +
        (looksUnescaped
          ? `\nSlack sent me \`${trimmed}\` with no channel id attached. Pick the channel from the autocomplete ` +
            "list instead of typing it, or paste its ID (starts with `C`). If it keeps happening, turn on " +
            "\"Escape channels, users, and links\" for this command in the Slack app settings."
          : "")
    );
    return;
  }

  const hours = SCAN.checkWindowHours;
  await respond(`Scanning <#${channelId}> for the last ${hours}h — one moment…`);

  const { candidates, threadsChecked, truncated } = await scanChannel(app.client, channelId, hours);
  if (candidates.length === 0) {
    await respond(
      `No starred messages in <#${channelId}> in the last ${hours}h (checked top-level messages and ` +
        `${threadsChecked} active thread(s))` +
        (truncated ? ". :warning: The scan hit its page/thread limit, so this may be incomplete." : ".")
    );
    return;
  }

  const lines = await explain(channelId, candidates);
  if (truncated) {
    lines.push(":warning: The scan hit its page/thread limit, so older activity may be missing.");
  }
  await respond(
    `Starred messages in <#${channelId}> in the last ${hours}h (${candidates.length}, ` +
      `${threadsChecked} thread(s) checked):\n${lines.join("\n")}`
  );
}

async function doReconcile(app: App, userId: string, respond: Respond): Promise<void> {
  if (isRunning()) {
    await respond("A reconcile is already running — its summary will be posted here when it finishes.");
    return;
  }
  await respond(
    `Reconcile started — watch it in <#${CHANNELS.log}>: it posts one message and streams every phase into ` +
      "that message's thread, then rewrites it into the summary when it's done. " +
      `At most ${RULES.maxCatchUpPostsPerRun} missed announcements will be posted, and only for messages ` +
      `younger than ${RULES.catchUpWindowHours}h.`
  );
  log.info(`Reconcile started by <@${userId}>`);
  // Deliberately not awaited: a run takes tens of minutes, far longer than
  // Slack's request lifetime.
  void reconcile(app);
}

export function registerCommands(app: App): void {
  const handler = (fixedVerb?: string) => async (args: Record<string, any>): Promise<void> => {
    const { command, ack, respond } = args;
    await ack();
    // Silent no-op elsewhere, so the command's existence isn't advertised.
    if (command.channel_id !== CHANNELS.log) return;

    const text = (command.text ?? "").trim();
    const verb = fixedVerb ?? text.split(/\s+/)[0]?.toLowerCase() ?? "";
    const rest = fixedVerb ? text : text.slice(verb.length).trim();
    const reply: Respond = (message) => respond({ text: message, response_type: "ephemeral" });

    try {
      if (verb === "status" || verb === "") {
        await reply((await statusLines()).join("\n") + `\n\n${USAGE}`);
      } else if (verb === "check") {
        await doCheck(app, rest, reply);
      } else if (verb === "reconcile" || verb === "sync") {
        await doReconcile(app, command.user_id, reply);
      } else {
        await reply(`Unknown subcommand \`${verb}\`.\n\n${USAGE}`);
      }
    } catch (err) {
      log.error(`Slash command \`${command.command} ${text}\` failed`, err);
      await reply("That failed — the error is in this channel.").catch(() => undefined);
    }
  };

  app.command("/hof", handler());
  app.command("/ninja-check", handler("check"));
  app.command("/ninja-sync", handler("reconcile"));
}
