import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import {
  deleteKickChatMessage,
  getValidKickAccessTokenForStreamer,
  getValidKickAccessTokenForViewer,
  sendKickChatMessage,
} from "../auth/kick.js";
import type { IncomingChatDelete, IncomingChatMessage } from "./twitch.js";
import {
  parseKickEmotesInContent,
  type ChatBadge,
} from "./meta.js";

const KICK_BADGE_LABEL: Record<string, string> = {
  moderator: "Mod",
  mod: "Mod",
  vip: "VIP",
  subscriber: "Sub",
  sub_gifter: "Gifter",
  staff: "Staff",
  broadcaster: "Host",
  founder: "Founder",
  og: "OG",
  verified: "Verified",
};

function kickBadgesFromIdentity(
  identity:
    | {
        color?: string;
        badges?: Array<{ type?: string; text?: string; count?: number }>;
      }
    | undefined,
): { color?: string; badges: ChatBadge[] } {
  const color =
    typeof identity?.color === "string" && identity.color.length > 0
      ? identity.color
      : undefined;
  const badges: ChatBadge[] = [];
  for (const b of identity?.badges ?? []) {
    const type = (b.type ?? "badge").toLowerCase();
    const title =
      b.text ??
      (KICK_BADGE_LABEL[type]
        ? b.count
          ? `${KICK_BADGE_LABEL[type]} x${b.count}`
          : KICK_BADGE_LABEL[type]
        : type);
    badges.push({ id: type, title });
  }
  return { color, badges };
}
const execFileAsync = promisify(execFile);

type MessageHandler = (msg: IncomingChatMessage) => void | Promise<void>;
type DeleteHandler = (evt: IncomingChatDelete) => void | Promise<void>;

interface KickListener {
  ws?: WebSocket;
  stopped: boolean;
  /** Dedupa eventos Pusher duplicados (mesmo texto, ids diferentes) */
  recentSeen: Map<string, number>;
}

const listeners = new Map<string, KickListener>();
const KICK_DEDUP_TTL_MS = 4_000;

function kickDedupeKey(senderId: string, content: string) {
  return `${senderId}:${content}`;
}

function isDuplicateKickEvent(
  state: KickListener,
  senderId: string,
  content: string,
): boolean {
  const now = Date.now();
  for (const [k, exp] of state.recentSeen) {
    if (exp < now) state.recentSeen.delete(k);
  }
  const key = kickDedupeKey(senderId, content);
  const exp = state.recentSeen.get(key);
  if (exp && exp > now) return true;
  state.recentSeen.set(key, now + KICK_DEDUP_TTL_MS);
  return false;
}
/**
 * kick.com/api/v2 é protegido por Cloudflare: o fetch do Node costuma tomar 403,
 * enquanto curl.exe no Windows passa. Tentamos fetch e caímos para curl.
 */
async function fetchJsonViaCurl(url: string): Promise<unknown> {
  const curlBin = process.platform === "win32" ? "curl.exe" : "curl";
  const { stdout } = await execFileAsync(
    curlBin,
    [
      "-sS",
      "-A",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "-H",
      "Accept: application/json",
      url,
    ],
    { maxBuffer: 2 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

export async function fetchKickChatroomId(
  slug: string,
): Promise<{ chatroomId: number; channelId: number; userId: number }> {
  const url = `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`;

  let data: {
    id?: number;
    user_id?: number;
    chatroom?: { id?: number };
  };

  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: `https://kick.com/${encodeURIComponent(slug)}`,
      },
    });
    if (!res.ok) {
      throw new Error(`fetch ${res.status}`);
    }
    data = (await res.json()) as typeof data;
  } catch {
    data = (await fetchJsonViaCurl(url)) as typeof data;
  }

  if (!data.chatroom?.id || !data.id) {
    throw new Error("Kick chatroom id não encontrado");
  }
  return {
    chatroomId: data.chatroom.id,
    channelId: data.id,
    userId: data.user_id ?? data.id,
  };
}

export async function sendKickChatAsStreamer(
  streamerTwitchUserId: string,
  content: string,
): Promise<{ messageId: string }> {
  const { accessToken, kickUserId } =
    await getValidKickAccessTokenForStreamer(streamerTwitchUserId);
  if (!kickUserId) throw new Error("kickUserId ausente");
  return sendKickChatMessage(accessToken, kickUserId, content);
}

/** Posta no canal Kick do streamer usando o token OAuth do viewer. */
export async function sendKickChatAsViewer(params: {
  viewerTwitchUserId: string;
  streamerKickUserId: string;
  content: string;
}): Promise<{ kickUserId: string; messageId: string }> {
  const viewer = await getValidKickAccessTokenForViewer(params.viewerTwitchUserId);
  if (!viewer) {
    throw new Error("Viewer sem Kick vinculado com token");
  }
  const { messageId } = await sendKickChatMessage(
    viewer.accessToken,
    params.streamerKickUserId,
    params.content,
  );
  return { kickUserId: viewer.kickUserId, messageId };
}

export async function deleteKickChatAsStreamer(
  streamerTwitchUserId: string,
  messageId: string,
): Promise<void> {
  const { accessToken } =
    await getValidKickAccessTokenForStreamer(streamerTwitchUserId);
  await deleteKickChatMessage(accessToken, messageId);
}

/**
 * Kick chat via Pusher websocket (public chatroom channel).
 */
export async function startKickChatListener(params: {
  streamerTwitchUserId: string;
  slug: string;
  chatroomId?: string | null;
  onMessage: MessageHandler;
  onDelete?: DeleteHandler;
}): Promise<void> {
  stopKickChatListener(params.streamerTwitchUserId);

  const state: KickListener = { stopped: false, recentSeen: new Map() };
  listeners.set(params.streamerTwitchUserId, state);

  let chatroomId = params.chatroomId ? Number(params.chatroomId) : NaN;
  if (!Number.isFinite(chatroomId)) {
    const resolved = await fetchKickChatroomId(params.slug);
    chatroomId = resolved.chatroomId;
  }

  console.log(
    `[kick] listening slug=${params.slug} chatroom=${chatroomId} streamer=${params.streamerTwitchUserId}`,
  );

  const pusherKey = "32cbd69e4b950bf97679";
  const wsUrl = `wss://ws-us2.pusher.com/app/${pusherKey}?protocol=7&client=js&version=8.4.0&flash=false`;

  const connect = () => {
    if (state.stopped) return;
    // Evita duas conexões Pusher (cada uma entrega o mesmo chat)
    if (state.ws && state.ws.readyState <= WebSocket.OPEN) {
      try {
        state.ws.close();
      } catch {
        /* ignore */
      }
    }
    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    ws.on("open", () => {
      if (state.stopped || state.ws !== ws) {
        ws.close();
        return;
      }
      ws.send(
        JSON.stringify({
          event: "pusher:subscribe",
          data: { auth: "", channel: `chatrooms.${chatroomId}.v2` },
        }),
      );
    });

    ws.on("message", async (raw) => {
      if (state.stopped || state.ws !== ws) return;
      try {
        const packet = JSON.parse(raw.toString()) as {
          event?: string;
          data?: string | Record<string, unknown>;
        };

        if (packet.event === "pusher:ping") {
          ws.send(JSON.stringify({ event: "pusher:pong", data: {} }));
          return;
        }

        const eventName = packet.event ?? "";
        if (packet.data == null) return;

        const data =
          typeof packet.data === "string"
            ? (JSON.parse(packet.data) as Record<string, unknown>)
            : packet.data;

        if (
          eventName.includes("MessageDeleted") ||
          eventName.includes("ChatMessageDeleted") ||
          eventName.includes("MessageDelete")
        ) {
          const messageId = String(
            data.id ??
              data.message_id ??
              (data.message as { id?: string } | undefined)?.id ??
              "",
          );
          if (messageId && params.onDelete) {
            console.log(`[kick] deleted id=${messageId} event=${eventName}`);
            await params.onDelete({
              platform: "kick",
              messageId,
              streamerTwitchUserId: params.streamerTwitchUserId,
            });
          } else {
            console.log(`[kick] delete event sem id: ${eventName}`, data);
          }
          return;
        }

        if (!eventName.includes("ChatMessageEvent")) return;

        const rawContent = data.content as string | undefined;
        const sender = data.sender as
          | {
              id?: number;
              username?: string;
              identity?: {
                color?: string;
                badges?: Array<{ type?: string; text?: string; count?: number }>;
              };
            }
          | undefined;
        if (!rawContent || sender?.id == null) return;

        const messageId = String(
          data.id ??
            data.message_id ??
            (data.message as { id?: string } | undefined)?.id ??
            `kick-${Date.now()}`,
        );

        const { plain, emotes } = parseKickEmotesInContent(rawContent);
        const { color, badges } = kickBadgesFromIdentity(sender.identity);
        const senderId = String(sender.id);

        if (isDuplicateKickEvent(state, senderId, plain)) {
          console.log(
            `[kick] dedupe skip from=${sender.username ?? senderId} msgId=${messageId}`,
          );
          return;
        }

        console.log(
          `[kick] msg from=${sender.username ?? senderId} msgId=${messageId}: ${plain.slice(0, 80)}`,
        );

        await params.onMessage({
          platform: "kick",
          platformUserId: senderId,
          displayName: sender.username ?? senderId,
          message: plain,
          messageId,
          streamerTwitchUserId: params.streamerTwitchUserId,
          color,
          badges,
          emotes,
        });
      } catch (err) {
        console.error("[kick ws parse]", err);
      }
    });

    ws.on("close", () => {
      if (state.ws !== ws) return;
      if (!state.stopped) {
        console.log(`[kick] ws closed, reconnecting chatroom=${chatroomId}`);
        setTimeout(connect, 5_000);
      }
    });

    ws.on("error", (err) => {
      console.error("[kick ws]", err);
      if (state.ws === ws) ws.close();
    });
  };

  connect();
}

export function stopKickChatListener(streamerTwitchUserId: string) {
  const state = listeners.get(streamerTwitchUserId);
  if (!state) return;
  state.stopped = true;
  state.ws?.close();
  listeners.delete(streamerTwitchUserId);
}
