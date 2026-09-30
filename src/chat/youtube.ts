import type { youtube_v3 } from "googleapis";
import {
  getStreamerYouTubeClient,
  getViewerYouTubeClient,
} from "../auth/youtube.js";
import type { IncomingChatDelete, IncomingChatMessage } from "./twitch.js";

type MessageHandler = (msg: IncomingChatMessage) => void | Promise<void>;
type DeleteHandler = (evt: IncomingChatDelete) => void | Promise<void>;

interface PollState {
  timer?: NodeJS.Timeout;
  liveChatId?: string;
  pageToken?: string;
  stopped: boolean;
  loggedWaiting?: boolean;
  /** A 1ª página do liveChat traz o histórico recente; ignora o que é anterior ao start. */
  startedAt: number;
}

const polls = new Map<string, PollState>();

export async function resolveLiveChatId(
  youtube: youtube_v3.Youtube,
): Promise<string | null> {
  const broadcasts = await youtube.liveBroadcasts.list({
    part: ["snippet", "contentDetails", "status"],
    broadcastStatus: "active",
    maxResults: 5,
  });

  const active = broadcasts.data.items?.find(
    (b) => b.snippet?.liveChatId && b.status?.lifeCycleStatus === "live",
  );
  return active?.snippet?.liveChatId ?? null;
}

async function insertLiveChatMessage(
  youtube: youtube_v3.Youtube,
  liveChatId: string,
  message: string,
): Promise<{ messageId: string }> {
  const res = await youtube.liveChatMessages.insert({
    part: ["snippet"],
    requestBody: {
      snippet: {
        liveChatId,
        type: "textMessageEvent",
        textMessageDetails: { messageText: message },
      },
    },
  });
  const messageId = res.data.id;
  if (!messageId) throw new Error("YouTube insert: id ausente");
  return { messageId };
}

/** Posta no chat da live do streamer com a conta YouTube do streamer. */
export async function sendYouTubeChatAsStreamer(
  streamerTwitchUserId: string,
  message: string,
): Promise<{ liveChatId: string; channelId: string; messageId: string }> {
  const { youtube, streamer } = await getStreamerYouTubeClient(streamerTwitchUserId);
  const liveChatId = await resolveLiveChatId(youtube);
  if (!liveChatId) throw new Error("Nenhuma live YouTube ativa com chat");
  if (!streamer.youtubeChannelId) throw new Error("youtubeChannelId ausente");
  const { messageId } = await insertLiveChatMessage(youtube, liveChatId, message);
  return { liveChatId, channelId: streamer.youtubeChannelId, messageId };
}

/** Posta no chat da live do streamer com a conta YouTube do viewer. */
export async function sendYouTubeChatAsViewer(params: {
  streamerTwitchUserId: string;
  viewerTwitchUserId: string;
  message: string;
}): Promise<{ channelId: string; messageId: string }> {
  const viewer = await getViewerYouTubeClient(params.viewerTwitchUserId);
  if (!viewer) throw new Error("Viewer sem YouTube vinculado com token");

  const { youtube: streamerYt } = await getStreamerYouTubeClient(
    params.streamerTwitchUserId,
  );
  const liveChatId = await resolveLiveChatId(streamerYt);
  if (!liveChatId) throw new Error("Nenhuma live YouTube ativa com chat");

  const { messageId } = await insertLiveChatMessage(
    viewer.youtube,
    liveChatId,
    params.message,
  );
  return { channelId: viewer.channelId, messageId };
}

export async function deleteYouTubeChatMessage(params: {
  streamerTwitchUserId: string;
  messageId: string;
}): Promise<void> {
  const { youtube } = await getStreamerYouTubeClient(params.streamerTwitchUserId);
  try {
    await youtube.liveChatMessages.delete({ id: params.messageId });
  } catch (err: unknown) {
    const status = (err as { code?: number })?.code;
    if (status === 404) return;
    throw err;
  }
}

/** @deprecated use sendYouTubeChatAsStreamer */
export async function sendYouTubeChatMessage(
  streamerTwitchUserId: string,
  message: string,
): Promise<void> {
  await sendYouTubeChatAsStreamer(streamerTwitchUserId, message);
}

export async function startYouTubeChatPolling(params: {
  streamerTwitchUserId: string;
  onMessage: MessageHandler;
  onDelete?: DeleteHandler;
}): Promise<void> {
  stopYouTubeChatPolling(params.streamerTwitchUserId);

  const state: PollState = { stopped: false, startedAt: Date.now() };
  polls.set(params.streamerTwitchUserId, state);

  console.log(`[youtube] polling start streamer=${params.streamerTwitchUserId}`);

  const tick = async () => {
    if (state.stopped) return;
    try {
      const { youtube } = await getStreamerYouTubeClient(params.streamerTwitchUserId);
      if (!state.liveChatId) {
        state.liveChatId = (await resolveLiveChatId(youtube)) ?? undefined;
        if (state.liveChatId) {
          console.log(
            `[youtube] liveChatId=${state.liveChatId} streamer=${params.streamerTwitchUserId}`,
          );
          state.loggedWaiting = false;
        } else if (!state.loggedWaiting) {
          console.log(
            `[youtube] aguardando live ativa streamer=${params.streamerTwitchUserId}`,
          );
          state.loggedWaiting = true;
        }
      }
      if (!state.liveChatId) {
        state.timer = setTimeout(tick, 15_000);
        return;
      }

      const res = await youtube.liveChatMessages.list({
        liveChatId: state.liveChatId,
        part: ["snippet", "authorDetails"],
        pageToken: state.pageToken,
      });

      state.pageToken = res.data.nextPageToken ?? state.pageToken;
      const waitMs = res.data.pollingIntervalMillis ?? 5000;

      for (const item of res.data.items ?? []) {
        const type = item.snippet?.type;
        const publishedAt = Date.parse(item.snippet?.publishedAt ?? "");
        if (Number.isFinite(publishedAt) && publishedAt < state.startedAt) continue;

        if (type === "messageDeletedEvent") {
          const deletedId =
            item.snippet?.messageDeletedDetails?.deletedMessageId ?? item.id;
          if (deletedId && params.onDelete) {
            console.log(`[youtube] deleted id=${deletedId}`);
            await params.onDelete({
              platform: "youtube",
              messageId: deletedId,
              streamerTwitchUserId: params.streamerTwitchUserId,
            });
          }
          continue;
        }

        const authorId = item.authorDetails?.channelId;
        const text = item.snippet?.displayMessage;
        if (!authorId || !text) continue;
        if (type && type !== "textMessageEvent") continue;

        console.log(
          `[youtube] msg from=${item.authorDetails?.displayName ?? authorId} id=${authorId}: ${text.slice(0, 80)}`,
        );

        await params.onMessage({
          platform: "youtube",
          platformUserId: authorId,
          displayName: item.authorDetails?.displayName ?? authorId,
          message: text,
          messageId: item.id ?? `yt-${Date.now()}`,
          streamerTwitchUserId: params.streamerTwitchUserId,
          badges: [
            ...(item.authorDetails?.isChatOwner
              ? [{ id: "owner", title: "Owner" }]
              : []),
            ...(item.authorDetails?.isChatModerator
              ? [{ id: "moderator", title: "Mod" }]
              : []),
            ...(item.authorDetails?.isChatSponsor
              ? [{ id: "member", title: "Member" }]
              : []),
          ],
        });
      }

      state.timer = setTimeout(tick, waitMs);
    } catch (err) {
      console.error("[youtube poll]", err);
      state.liveChatId = undefined;
      state.timer = setTimeout(tick, 20_000);
    }
  };

  void tick();
}

export function stopYouTubeChatPolling(streamerTwitchUserId: string) {
  const state = polls.get(streamerTwitchUserId);
  if (!state) return;
  state.stopped = true;
  if (state.timer) clearTimeout(state.timer);
  polls.delete(streamerTwitchUserId);
}
