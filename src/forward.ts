// Mirrors what a starred message actually says into the log channel.
//
// #hall-of-fame deliberately holds nothing but `⭐ N` and a permalink, and the
// bot is a member of private channels as well as public ones — so an
// announcement is often a link the reader cannot open, and an approval request
// asks a human to decide about a message they cannot see. Neither is fixable in
// #hall-of-fame without publishing other people's content there, so the text
// goes to the log channel instead: private, already full of the bot's internal
// state, and read by whoever operates this.
//
// Nothing here throws and nothing here is load-bearing. A forward that fails is
// a log line; the announcement it describes has already happened.

import type { WebClient } from "@slack/web-api";
import { CHANNELS, FORWARD } from "./config";
import { log } from "./log";
import { channelInfo, fetchMessage, messageContent } from "./slack";

export interface ForwardTarget {
  channelId: string;
  messageId: string;
}

// Who wrote it. Bot and emailed-in messages have no `user`, so they fall back to
// whatever name Slack attached — an unattributed forward is much harder to make
// sense of than a slightly ugly one.
function authorOf(message: Record<string, any> | undefined): string {
  const user = message?.user as string | undefined;
  if (user) return `<@${user}>`;
  const username = (message?.username as string) || (message?.bot_profile as Record<string, any>)?.name;
  if (username) return `*${username}* (app)`;
  return "_unknown author_";
}

// "in #channel", with private channels called out. The note is the point rather
// than a detail: it is the reason the permalink next to it doesn't work for most
// people, so a reader who can't open the link knows why.
async function originOf(client: WebClient, channelId: string): Promise<string> {
  const info = await channelInfo(client, channelId);
  if (!info) return `in <#${channelId}>`;
  if (info.isPrivate) return `in <#${channelId}> _(private — the permalink only opens for members)_`;
  return `in <#${channelId}>`;
}

// The full rendering of one message: where it came from, who wrote it, and what
// it says. Used both for a standalone forward and folded into the approval
// request, so a held message and a posted one read the same way.
export async function describeMessage(
  client: WebClient,
  target: ForwardTarget,
  permalink: string
): Promise<string> {
  const message = await fetchMessage(client, target.channelId, target.messageId);
  const origin = await originOf(client, target.channelId);
  const content = messageContent(message, {
    maxChars: FORWARD.maxContentChars,
    maxFileChars: FORWARD.maxFileTextChars,
  });
  return `${authorOf(message)} ${origin} — <${permalink}|open>\n${content}`;
}

// Posts the content of a message that has just been announced. Awaited by the
// caller rather than fired and forgotten, so it still runs when the process is a
// short-lived `hof post` rather than the long-running bot.
export async function forwardAnnouncement(
  client: WebClient,
  target: ForwardTarget,
  stars: number,
  permalink: string
): Promise<void> {
  if (!FORWARD.enabled) return;
  try {
    const body = await describeMessage(client, target, permalink);
    await client.chat.postMessage({
      channel: CHANNELS.log,
      text: `Announced ${stars}⭐ — ${permalink}`,
      // The permalink is already in the body as a labelled link; unfurling it
      // would repeat the whole message underneath itself.
      unfurl_links: false,
      unfurl_media: false,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `:star: *${stars}* — announced in <#${CHANNELS.hallOfFame}>\n${body}` },
        },
      ],
    });
  } catch (err) {
    // Deliberately a warning: the announcement succeeded, only the copy of it
    // here did not, and log.error would ping a human about a cosmetic failure.
    log.warn(`Could not forward the content of ${permalink} to the log channel`, err);
  }
}
