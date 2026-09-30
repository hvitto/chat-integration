import tmi from "tmi.js";
import { env } from "../config.js";
import {
  getValidStreamerAccessToken,
  getValidViewerAccessToken,
} from "../auth/twitch.js";
import {
  parseTwitchEmotes,
  type ChatBadge,
  type ChatEmoteSpan,
} from "./meta.js";
import { resolveTwitchBadges } from "./twitchBadges.js";

export interface IncomingChatMessage {
  platform: "twitch" | "youtube" | "kick";
  platformUserId: string;
  displayName: string;
  message: string;
  messageId: string;
  streamerTwitchUserId: string;
  color?: string;
  badges?: ChatBadge[];
  emotes?: ChatEmoteSpan[];
}

export interface IncomingChatDelete {
  platform: "twitch" | "youtube" | "kick";
  messageId: string;
  streamerTwitchUserId: string;
}

type MessageHandler = (msg: IncomingChatMessage) => void | Promise<void>;
type DeleteHandler = (evt: IncomingChatDelete) => void | Promise<void>;

const listeners = new Map<string, tmi.Client>();
/** Invalida handlers de clients antigos após stop/restart */
const listenerGeneration = new Map<string, number>();

export async function sendTwitchChatAsViewer(params: {
  viewerTwitchUserId: string;
  broadcasterId: string;
  message: string;
}): Promise<{ messageId: string }> {
  const accessToken = await getValidViewerAccessToken(params.viewerTwitchUserId);
  const res = await fetch("https://api.twitch.tv/helix/chat/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Client-Id": env.TWITCH_CLIENT_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      broadcaster_id: params.broadcasterId,
      sender_id: params.viewerTwitchUserId,
      message: params.message,
    }),
  });
  if (!res.ok) {
    throw new Error(`Twitch send chat failed: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    data?: Array<{ message_id?: string }>;
  };
  const messageId = body.data?.[0]?.message_id;
  if (!messageId) throw new Error("Twitch send chat: message_id ausente");
  return { messageId };
}

export async function deleteTwitchChatMessage(params: {
  broadcasterId: string;
  moderatorId: string;
  messageId: string;
}): Promise<void> {
  const accessToken = await getValidStreamerAccessToken(params.moderatorId);
  const url = new URL("https://api.twitch.tv/helix/moderation/chat");
  url.searchParams.set("broadcaster_id", params.broadcasterId);
  url.searchParams.set("moderator_id", params.moderatorId);
  url.searchParams.set("message_id", params.messageId);

  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Client-Id": env.TWITCH_CLIENT_ID,
    },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Twitch delete chat failed: ${await res.text()}`);
  }
}

export async function startTwitchChatListener(params: {
  streamerTwitchUserId: string;
  channelLogin: string;
  botLogin: string;
  botAccessToken: string;
  onMessage: MessageHandler;
  onDelete?: DeleteHandler;
}): Promise<void> {
  stopTwitchChatListener(params.streamerTwitchUserId);

  const generation = (listenerGeneration.get(params.streamerTwitchUserId) ?? 0) + 1;
  listenerGeneration.set(params.streamerTwitchUserId, generation);

  const client = new tmi.Client({
    options: { debug: false },
    connection: { reconnect: true, secure: true },
    identity: {
      username: params.botLogin,
      password: `oauth:${params.botAccessToken}`,
    },
    channels: [params.channelLogin],
  });

  client.on("message", async (_channel, tags, message, self) => {
    // Descarta eventos de client antigo após restart/reconnect
    if (listenerGeneration.get(params.streamerTwitchUserId) !== generation) return;
    if (listeners.get(params.streamerTwitchUserId) !== client) return;

    const userId = tags["user-id"];
    if (!userId) return;

    const emotes = parseTwitchEmotes(
      tags.emotes ?? (tags["emotes-raw"] as string | undefined) ?? undefined,
      message,
    );
    let badges: ChatBadge[] = [];
    try {
      badges = await resolveTwitchBadges(
        tags.badges ?? undefined,
        params.streamerTwitchUserId,
        typeof tags["badges-raw"] === "string" ? tags["badges-raw"] : null,
      );
    } catch (err) {
      console.error("[twitch] badge resolve", err);
    }

    if (self) {
      console.log(
        `[twitch] self msg badges=${badges.map((b) => b.id).join(",") || "none"} emotes=${emotes.length}`,
      );
    }

    const color =
      typeof tags.color === "string" && tags.color.length > 0
        ? tags.color
        : undefined;

    await params.onMessage({
      platform: "twitch",
      platformUserId: userId,
      displayName: tags["display-name"] ?? tags.username ?? userId,
      message,
      messageId: tags.id ?? `${Date.now()}`,
      streamerTwitchUserId: params.streamerTwitchUserId,
      color,
      badges,
      emotes,
    });
  });

  client.on("messagedeleted", async (_channel, _username, _deletedMessage, userstate) => {
    if (listenerGeneration.get(params.streamerTwitchUserId) !== generation) return;
    if (listeners.get(params.streamerTwitchUserId) !== client) return;
    const messageId = userstate["target-msg-id"];
    if (!messageId || !params.onDelete) return;
    await params.onDelete({
      platform: "twitch",
      messageId,
      streamerTwitchUserId: params.streamerTwitchUserId,
    });
  });

  await client.connect();
  listeners.set(params.streamerTwitchUserId, client);
}

export function stopTwitchChatListener(streamerTwitchUserId: string) {
  listenerGeneration.set(
    streamerTwitchUserId,
    (listenerGeneration.get(streamerTwitchUserId) ?? 0) + 1,
  );
  const client = listeners.get(streamerTwitchUserId);
  if (client) {
    listeners.delete(streamerTwitchUserId);
    void client.disconnect().catch(() => undefined);
  }
}
