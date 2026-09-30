import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { relayLogs, streamers } from "../db/schema.js";
import { findTwitchUserByPlatformIdentity } from "../identity/service.js";
import {
  deleteTwitchChatMessage,
  sendTwitchChatAsViewer,
  startTwitchChatListener,
  stopTwitchChatListener,
  type IncomingChatDelete,
  type IncomingChatMessage,
} from "../chat/twitch.js";
import {
  deleteYouTubeChatMessage,
  sendYouTubeChatAsStreamer,
  sendYouTubeChatAsViewer,
  startYouTubeChatPolling,
  stopYouTubeChatPolling,
} from "../chat/youtube.js";
import {
  deleteKickChatAsStreamer,
  fetchKickChatroomId,
  sendKickChatAsStreamer,
  sendKickChatAsViewer,
  startKickChatListener,
  stopKickChatListener,
} from "../chat/kick.js";
import { getValidStreamerAccessToken } from "../auth/twitch.js";
import { getValidKickAccessTokenForViewer } from "../auth/kick.js";
import { getViewerYouTubeClient } from "../auth/youtube.js";
import {
  type ChatPlatform,
  findSiblingMessages,
  markGroupDeleted,
  newRelayGroupId,
  recordRelayedGroup,
} from "./messages.js";
import { publishOverlay } from "../overlay/bus.js";
import { buildOverlayMessage, metaFromIncoming, mergeOriginWithTwitchEmotes } from "../overlay/format.js";
import type { ChatStyleMeta } from "../chat/meta.js";

/** Track message ids / fingerprints we originated to avoid echo loops */
const recentRelayIds = new Set<string>();
const recentFingerprints = new Map<string, number>();
const recentPropagatedDeletes = new Set<string>();
/** messageId Twitch → plataforma de origem (kick/youtube) para o badge do overlay */
const overlayOriginByTwitchMsgId = new Map<string, ChatPlatform>();
/** streamer:twitchUserId:message → origem, cobre race Helix/IRC com ids diferentes */
const overlayOriginByContent = new Map<string, { platform: ChatPlatform; expires: number }>();
/** helix message ids já publicados no overlay → plataforma de origem */
const overlayPublishedTwitchIds = new Map<string, ChatPlatform>();
/** streamer:twitchUserId:message — IRC já enriqueceu; Kick/YT não republica snapshot */
const overlayContentEnriched = new Map<string, number>();
/** Meta visual da origem (cor/badges Kick/YT) para o eco IRC não sobrescrever */
const overlayOriginStyleByContent = new Map<
  string,
  { meta: ChatStyleMeta; expires: number }
>();
const MAX_RECENT = 2000;
const FINGERPRINT_TTL_MS = 15_000;

function contentOriginKey(streamerId: string, twitchUserId: string, message: string) {
  return `${streamerId}:${twitchUserId}:${message}`;
}

function markRelayed(id: string) {
  recentRelayIds.add(id);
  if (recentRelayIds.size > MAX_RECENT) {
    const first = recentRelayIds.values().next().value;
    if (first) recentRelayIds.delete(first);
  }
}

function markFingerprint(streamerId: string, userId: string, message: string) {
  const key = `${streamerId}:${userId}:${message}`;
  recentFingerprints.set(key, Date.now() + FINGERPRINT_TTL_MS);
}

function rememberOriginStyle(
  streamerId: string,
  twitchUserId: string,
  message: string,
  meta: ChatStyleMeta,
) {
  const key = contentOriginKey(streamerId, twitchUserId, message);
  overlayOriginStyleByContent.set(key, {
    meta: {
      color: meta.color,
      badges: meta.badges,
      emotes: meta.emotes,
    },
    expires: Date.now() + FINGERPRINT_TTL_MS,
  });
}

function takeOriginStyle(
  streamerId: string,
  twitchUserId: string,
  message: string,
): ChatStyleMeta | undefined {
  const key = contentOriginKey(streamerId, twitchUserId, message);
  const hit = overlayOriginStyleByContent.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    overlayOriginStyleByContent.delete(key);
    return undefined;
  }
  return hit.meta;
}

function markOverlayOrigin(
  streamerId: string,
  twitchUserId: string,
  message: string,
  platform: ChatPlatform,
  twitchMessageId?: string,
) {
  const expires = Date.now() + FINGERPRINT_TTL_MS;
  overlayOriginByContent.set(contentOriginKey(streamerId, twitchUserId, message), {
    platform,
    expires,
  });
  if (twitchMessageId) {
    overlayOriginByTwitchMsgId.set(twitchMessageId, platform);
    overlayPublishedTwitchIds.set(twitchMessageId, platform);
    if (overlayPublishedTwitchIds.size > MAX_RECENT) {
      const first = overlayPublishedTwitchIds.keys().next().value;
      if (first) overlayPublishedTwitchIds.delete(first);
    }
  }
}

function takeOverlayOrigin(
  streamerId: string,
  twitchUserId: string,
  message: string,
  twitchMessageId: string,
): ChatPlatform | null {
  const byId = overlayOriginByTwitchMsgId.get(twitchMessageId);
  if (byId) {
    overlayOriginByTwitchMsgId.delete(twitchMessageId);
    return byId;
  }
  const published = overlayPublishedTwitchIds.get(twitchMessageId);
  if (published) return published;
  const key = contentOriginKey(streamerId, twitchUserId, message);
  const byContent = overlayOriginByContent.get(key);
  if (!byContent) return null;
  if (byContent.expires < Date.now()) {
    overlayOriginByContent.delete(key);
    return null;
  }
  overlayOriginByContent.delete(key);
  return byContent.platform;
}

function isEcho(id: string) {
  return recentRelayIds.has(id);
}

function isRecentFingerprint(streamerId: string, userId: string, message: string) {
  const key = `${streamerId}:${userId}:${message}`;
  const expires = recentFingerprints.get(key);
  if (!expires) return false;
  if (expires < Date.now()) {
    recentFingerprints.delete(key);
    return false;
  }
  return true;
}

function markPropagatedDelete(platform: ChatPlatform, messageId: string) {
  const key = `${platform}:${messageId}`;
  recentPropagatedDeletes.add(key);
  if (recentPropagatedDeletes.size > MAX_RECENT) {
    const first = recentPropagatedDeletes.values().next().value;
    if (first) recentPropagatedDeletes.delete(first);
  }
}

function wasPropagatedDelete(platform: ChatPlatform, messageId: string) {
  return recentPropagatedDeletes.has(`${platform}:${messageId}`);
}

async function logRelay(entry: {
  streamerTwitchUserId: string;
  fromPlatform: string;
  toPlatform: string;
  sourceUserId?: string;
  resolvedTwitchUserId?: string;
  messagePreview: string;
  status: "relayed" | "skipped_unlinked" | "skipped_disabled" | "error";
  errorMessage?: string;
}) {
  await db.insert(relayLogs).values({
    streamerTwitchUserId: entry.streamerTwitchUserId,
    fromPlatform: entry.fromPlatform,
    toPlatform: entry.toPlatform,
    sourceUserId: entry.sourceUserId,
    resolvedTwitchUserId: entry.resolvedTwitchUserId,
    messagePreview: entry.messagePreview.slice(0, 200),
    status: entry.status,
    errorMessage: entry.errorMessage,
  });
}

export async function handleMessageDeleted(evt: IncomingChatDelete) {
  publishOverlay(evt.streamerTwitchUserId, {
    type: "delete",
    platform: evt.platform,
    messageId: evt.messageId,
  });

  if (wasPropagatedDelete(evt.platform, evt.messageId)) return;

  const found = await findSiblingMessages({
    platform: evt.platform,
    messageId: evt.messageId,
    streamerTwitchUserId: evt.streamerTwitchUserId,
  });
  if (!found) return;

  console.log(
    `[relay] delete sync from=${evt.platform} id=${evt.messageId} siblings=${found.siblings.length}`,
  );

  await markGroupDeleted(found.groupId);

  for (const sib of found.siblings) {
    try {
      markPropagatedDelete(sib.platform, sib.messageId);
      publishOverlay(evt.streamerTwitchUserId, {
        type: "delete",
        platform: sib.platform,
        messageId: sib.messageId,
      });
      if (sib.platform === "twitch") {
        await deleteTwitchChatMessage({
          broadcasterId: evt.streamerTwitchUserId,
          moderatorId: evt.streamerTwitchUserId,
          messageId: sib.messageId,
        });
      } else if (sib.platform === "kick") {
        await deleteKickChatAsStreamer(evt.streamerTwitchUserId, sib.messageId);
      } else if (sib.platform === "youtube") {
        await deleteYouTubeChatMessage({
          streamerTwitchUserId: evt.streamerTwitchUserId,
          messageId: sib.messageId,
        });
      }
    } catch (err) {
      console.error(
        `[relay] delete failed ${sib.platform}:${sib.messageId}`,
        err,
      );
    }
  }
}

export async function handleIncomingMessage(msg: IncomingChatMessage) {
  if (isEcho(msg.messageId)) return;

  const streamer = await db.query.streamers.findFirst({
    where: eq(streamers.twitchUserId, msg.streamerTwitchUserId),
  });
  if (!streamer) return;

  if (
    (msg.platform === "youtube" &&
      streamer.youtubeChannelId &&
      msg.platformUserId === streamer.youtubeChannelId) ||
    (msg.platform === "kick" &&
      streamer.kickUserId &&
      msg.platformUserId === streamer.kickUserId)
  ) {
    return;
  }

  // Overlay Twitch ANTES do fingerprint: eco de relay ainda enriquece cor/badges/emotes
  if (msg.platform === "twitch") {
    const origin = takeOverlayOrigin(
      msg.streamerTwitchUserId,
      msg.platformUserId,
      msg.message,
      msg.messageId,
    );
    if (origin && origin !== "twitch") {
      overlayPublishedTwitchIds.delete(msg.messageId);
      const cKey = contentOriginKey(
        msg.streamerTwitchUserId,
        msg.platformUserId,
        msg.message,
      );
      overlayContentEnriched.set(cKey, Date.now() + FINGERPRINT_TTL_MS);
      const originStyle = takeOriginStyle(
        msg.streamerTwitchUserId,
        msg.platformUserId,
        msg.message,
      );
      // Mantém cor/badges da origem (Kick/YT); só mescla emotes Twitch/7TV
      publishOverlay(
        msg.streamerTwitchUserId,
        await buildOverlayMessage({
          platform: origin,
          messageId: msg.messageId,
          displayName: msg.displayName,
          message: msg.message,
          linked: true,
          meta: mergeOriginWithTwitchEmotes(originStyle, metaFromIncoming(msg)),
          preferNativeColor: true,
          streamerTwitchUserId: msg.streamerTwitchUserId,
        }),
      );
      return;
    }
    if (
      !isRecentFingerprint(
        msg.streamerTwitchUserId,
        msg.platformUserId,
        msg.message,
      )
    ) {
      publishOverlay(
        msg.streamerTwitchUserId,
        await buildOverlayMessage({
          platform: "twitch",
          messageId: msg.messageId,
          displayName: msg.displayName,
          message: msg.message,
          linked: true,
          meta: metaFromIncoming(msg),
          styleTwitchUserId: msg.platformUserId,
          streamerTwitchUserId: msg.streamerTwitchUserId,
        }),
      );
    }
  }

  if (
    isRecentFingerprint(msg.streamerTwitchUserId, msg.platformUserId, msg.message)
  ) {
    return;
  }

  if (!streamer.relayEnabled) {
    if (msg.platform === "youtube" || msg.platform === "kick") {
      publishOverlay(
        msg.streamerTwitchUserId,
        await buildOverlayMessage({
          platform: msg.platform,
          messageId: msg.messageId,
          displayName: msg.displayName,
          message: msg.message,
          linked: false,
          meta: metaFromIncoming(msg),
          streamerTwitchUserId: msg.streamerTwitchUserId,
        }),
      );
    }
    await logRelay({
      streamerTwitchUserId: msg.streamerTwitchUserId,
      fromPlatform: msg.platform,
      toPlatform: "none",
      sourceUserId: msg.platformUserId,
      messagePreview: msg.message,
      status: "skipped_disabled",
    });
    return;
  }

  const groupId = newRelayGroupId();
  const recorded: Array<{ platform: ChatPlatform; messageId: string }> = [
    { platform: msg.platform, messageId: msg.messageId },
  ];

  try {
    if (msg.platform === "youtube" || msg.platform === "kick") {
      const viewer = await findTwitchUserByPlatformIdentity(
        msg.platform,
        msg.platformUserId,
      );
      if (!viewer) {
        publishOverlay(
          msg.streamerTwitchUserId,
          await buildOverlayMessage({
            platform: msg.platform,
            messageId: msg.messageId,
            displayName: msg.displayName,
            message: msg.message,
            linked: false,
            meta: metaFromIncoming(msg),
            streamerTwitchUserId: msg.streamerTwitchUserId,
          }),
        );
        await logRelay({
          streamerTwitchUserId: msg.streamerTwitchUserId,
          fromPlatform: msg.platform,
          toPlatform: "twitch",
          sourceUserId: msg.platformUserId,
          messagePreview: msg.message,
          status: "skipped_unlinked",
        });
        return;
      }

      // Fingerprint + origem ANTES do send: IRC não pode republicar / bounce Kick↔Twitch
      markFingerprint(streamer.twitchUserId, viewer.twitchUserId, msg.message);
      // Trava também o user na plataforma de origem (evita Twitch→Kick duplicar)
      markFingerprint(streamer.twitchUserId, msg.platformUserId, msg.message);
      rememberOriginStyle(
        streamer.twitchUserId,
        viewer.twitchUserId,
        msg.message,
        metaFromIncoming(msg),
      );
      markOverlayOrigin(
        streamer.twitchUserId,
        viewer.twitchUserId,
        msg.message,
        msg.platform,
      );
      const twitchSent = await sendTwitchChatAsViewer({
        viewerTwitchUserId: viewer.twitchUserId,
        broadcasterId: streamer.twitchUserId,
        message: msg.message,
      });
      recorded.push({ platform: "twitch", messageId: twitchSent.messageId });
      markRelayed(msg.messageId);
      markRelayed(twitchSent.messageId);
      markOverlayOrigin(
        streamer.twitchUserId,
        viewer.twitchUserId,
        msg.message,
        msg.platform,
        twitchSent.messageId,
      );
      const cKey = contentOriginKey(
        streamer.twitchUserId,
        viewer.twitchUserId,
        msg.message,
      );
      const enrichedUntil = overlayContentEnriched.get(cKey);
      if (enrichedUntil && enrichedUntil > Date.now()) {
        console.log(
          `[overlay] skip origin snapshot — já enriquecido twitchMsg=${twitchSent.messageId}`,
        );
      } else {
        publishOverlay(
          msg.streamerTwitchUserId,
          await buildOverlayMessage({
            platform: msg.platform,
            messageId: twitchSent.messageId,
            displayName: viewer.twitchDisplayName,
            message: msg.message,
            linked: true,
            meta: metaFromIncoming(msg),
            preferNativeColor: true,
            streamerTwitchUserId: msg.streamerTwitchUserId,
          }),
        );
        console.log(
          `[overlay] publish origin=${msg.platform} color=${msg.color ?? "none"} twitchMsg=${twitchSent.messageId}`,
        );
      }
      await logRelay({
        streamerTwitchUserId: msg.streamerTwitchUserId,
        fromPlatform: msg.platform,
        toPlatform: "twitch",
        sourceUserId: msg.platformUserId,
        resolvedTwitchUserId: viewer.twitchUserId,
        messagePreview: msg.message,
        status: "relayed",
      });

      if (msg.platform === "youtube" && streamer.kickUserId) {
        try {
          const asViewer = await getValidKickAccessTokenForViewer(
            viewer.twitchUserId,
          );
          if (asViewer) {
            if (
              isRecentFingerprint(
                streamer.twitchUserId,
                asViewer.kickUserId,
                msg.message,
              )
            ) {
              console.log("[relay] skip YT→Kick — fingerprint");
            } else {
              markFingerprint(
                streamer.twitchUserId,
                asViewer.kickUserId,
                msg.message,
              );
              const sent = await sendKickChatAsViewer({
                viewerTwitchUserId: viewer.twitchUserId,
                streamerKickUserId: streamer.kickUserId,
                content: msg.message,
              });
              recorded.push({ platform: "kick", messageId: sent.messageId });
              markRelayed(sent.messageId);
              await logRelay({
                streamerTwitchUserId: msg.streamerTwitchUserId,
                fromPlatform: msg.platform,
                toPlatform: "kick",
                sourceUserId: msg.platformUserId,
                resolvedTwitchUserId: viewer.twitchUserId,
                messagePreview: msg.message,
                status: "relayed",
              });
            }
          } else if (
            isRecentFingerprint(
              streamer.twitchUserId,
              streamer.kickUserId,
              msg.message,
            )
          ) {
            console.log("[relay] skip YT→Kick streamer — fingerprint");
          } else {
            markFingerprint(
              streamer.twitchUserId,
              streamer.kickUserId,
              msg.message,
            );
            const sent = await sendKickChatAsStreamer(
              streamer.twitchUserId,
              msg.message,
            );
            recorded.push({ platform: "kick", messageId: sent.messageId });
            markRelayed(sent.messageId);
            await logRelay({
              streamerTwitchUserId: msg.streamerTwitchUserId,
              fromPlatform: msg.platform,
              toPlatform: "kick",
              sourceUserId: msg.platformUserId,
              resolvedTwitchUserId: viewer.twitchUserId,
              messagePreview: msg.message,
              status: "relayed",
            });
          }
        } catch (err) {
          await logRelay({
            streamerTwitchUserId: msg.streamerTwitchUserId,
            fromPlatform: msg.platform,
            toPlatform: "kick",
            sourceUserId: msg.platformUserId,
            messagePreview: msg.message,
            status: "error",
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (msg.platform === "kick" && streamer.youtubeChannelId) {
        try {
          const asViewer = await getViewerYouTubeClient(viewer.twitchUserId);
          let ytMessageId: string;
          let ytChannelId: string;
          if (asViewer) {
            const sent = await sendYouTubeChatAsViewer({
              streamerTwitchUserId: streamer.twitchUserId,
              viewerTwitchUserId: viewer.twitchUserId,
              message: msg.message,
            });
            ytMessageId = sent.messageId;
            ytChannelId = sent.channelId;
          } else {
            const sent = await sendYouTubeChatAsStreamer(
              streamer.twitchUserId,
              msg.message,
            );
            ytMessageId = sent.messageId;
            ytChannelId = sent.channelId;
          }
          recorded.push({ platform: "youtube", messageId: ytMessageId });
          markRelayed(ytMessageId);
          markFingerprint(streamer.twitchUserId, ytChannelId, msg.message);
          await logRelay({
            streamerTwitchUserId: msg.streamerTwitchUserId,
            fromPlatform: msg.platform,
            toPlatform: "youtube",
            sourceUserId: msg.platformUserId,
            resolvedTwitchUserId: viewer.twitchUserId,
            messagePreview: msg.message,
            status: "relayed",
          });
        } catch (err) {
          await logRelay({
            streamerTwitchUserId: msg.streamerTwitchUserId,
            fromPlatform: msg.platform,
            toPlatform: "youtube",
            sourceUserId: msg.platformUserId,
            messagePreview: msg.message,
            status: "error",
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        }
      }

      await recordRelayedGroup({
        groupId,
        streamerTwitchUserId: streamer.twitchUserId,
        messages: recorded,
      });
      return;
    }

    if (msg.platform === "twitch") {
      if (streamer.youtubeChannelId) {
        try {
          const isStreamerSelf = msg.platformUserId === streamer.twitchUserId;
          if (isStreamerSelf) {
            const sent = await sendYouTubeChatAsStreamer(
              streamer.twitchUserId,
              msg.message,
            );
            recorded.push({ platform: "youtube", messageId: sent.messageId });
            markRelayed(msg.messageId);
            markRelayed(sent.messageId);
            markFingerprint(streamer.twitchUserId, sent.channelId, msg.message);
            await logRelay({
              streamerTwitchUserId: msg.streamerTwitchUserId,
              fromPlatform: "twitch",
              toPlatform: "youtube",
              sourceUserId: msg.platformUserId,
              resolvedTwitchUserId: msg.platformUserId,
              messagePreview: msg.message,
              status: "relayed",
            });
          } else {
            const viewerYt = await getViewerYouTubeClient(msg.platformUserId);
            if (!viewerYt) {
              await logRelay({
                streamerTwitchUserId: msg.streamerTwitchUserId,
                fromPlatform: "twitch",
                toPlatform: "youtube",
                sourceUserId: msg.platformUserId,
                messagePreview: msg.message,
                status: "skipped_unlinked",
              });
            } else {
              const sent = await sendYouTubeChatAsViewer({
                streamerTwitchUserId: streamer.twitchUserId,
                viewerTwitchUserId: msg.platformUserId,
                message: msg.message,
              });
              recorded.push({ platform: "youtube", messageId: sent.messageId });
              markRelayed(msg.messageId);
              markRelayed(sent.messageId);
              markFingerprint(streamer.twitchUserId, sent.channelId, msg.message);
              await logRelay({
                streamerTwitchUserId: msg.streamerTwitchUserId,
                fromPlatform: "twitch",
                toPlatform: "youtube",
                sourceUserId: msg.platformUserId,
                resolvedTwitchUserId: msg.platformUserId,
                messagePreview: msg.message,
                status: "relayed",
              });
            }
          }
        } catch (err) {
          await logRelay({
            streamerTwitchUserId: msg.streamerTwitchUserId,
            fromPlatform: "twitch",
            toPlatform: "youtube",
            sourceUserId: msg.platformUserId,
            messagePreview: msg.message,
            status: "error",
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (streamer.kickUserId) {
        try {
          const isStreamerSelf = msg.platformUserId === streamer.twitchUserId;
          if (isStreamerSelf) {
            if (
              isRecentFingerprint(
                streamer.twitchUserId,
                streamer.kickUserId,
                msg.message,
              )
            ) {
              console.log("[relay] skip Kick send — fingerprint (streamer)");
            } else {
              markFingerprint(
                streamer.twitchUserId,
                streamer.kickUserId,
                msg.message,
              );
              const sent = await sendKickChatAsStreamer(
                streamer.twitchUserId,
                msg.message,
              );
              recorded.push({ platform: "kick", messageId: sent.messageId });
              markRelayed(msg.messageId);
              markRelayed(sent.messageId);
              await logRelay({
                streamerTwitchUserId: msg.streamerTwitchUserId,
                fromPlatform: "twitch",
                toPlatform: "kick",
                sourceUserId: msg.platformUserId,
                resolvedTwitchUserId: msg.platformUserId,
                messagePreview: msg.message,
                status: "relayed",
              });
            }
          } else {
            const viewerKick = await getValidKickAccessTokenForViewer(
              msg.platformUserId,
            );
            if (!viewerKick) {
              await logRelay({
                streamerTwitchUserId: msg.streamerTwitchUserId,
                fromPlatform: "twitch",
                toPlatform: "kick",
                sourceUserId: msg.platformUserId,
                messagePreview: msg.message,
                status: "skipped_unlinked",
              });
            } else if (
              isRecentFingerprint(
                streamer.twitchUserId,
                viewerKick.kickUserId,
                msg.message,
              )
            ) {
              console.log("[relay] skip Kick send — fingerprint (viewer)");
            } else {
              markFingerprint(
                streamer.twitchUserId,
                viewerKick.kickUserId,
                msg.message,
              );
              const sent = await sendKickChatAsViewer({
                viewerTwitchUserId: msg.platformUserId,
                streamerKickUserId: streamer.kickUserId,
                content: msg.message,
              });
              recorded.push({ platform: "kick", messageId: sent.messageId });
              markRelayed(msg.messageId);
              markRelayed(sent.messageId);
              await logRelay({
                streamerTwitchUserId: msg.streamerTwitchUserId,
                fromPlatform: "twitch",
                toPlatform: "kick",
                sourceUserId: msg.platformUserId,
                resolvedTwitchUserId: msg.platformUserId,
                messagePreview: msg.message,
                status: "relayed",
              });
            }
          }
        } catch (err) {
          await logRelay({
            streamerTwitchUserId: msg.streamerTwitchUserId,
            fromPlatform: "twitch",
            toPlatform: "kick",
            sourceUserId: msg.platformUserId,
            messagePreview: msg.message,
            status: "error",
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (recorded.length > 1) {
        await recordRelayedGroup({
          groupId,
          streamerTwitchUserId: streamer.twitchUserId,
          messages: recorded,
        });
      }
    }
  } catch (err) {
    await logRelay({
      streamerTwitchUserId: msg.streamerTwitchUserId,
      fromPlatform: msg.platform,
      toPlatform: "twitch",
      sourceUserId: msg.platformUserId,
      messagePreview: msg.message,
      status: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function syncRelayWorkers(streamerTwitchUserId: string) {
  const streamer = await db.query.streamers.findFirst({
    where: eq(streamers.twitchUserId, streamerTwitchUserId),
  });
  if (!streamer) return;

  stopTwitchChatListener(streamerTwitchUserId);
  stopYouTubeChatPolling(streamerTwitchUserId);
  stopKickChatListener(streamerTwitchUserId);

  if (!streamer.relayEnabled) return;

  const hasOther = Boolean(streamer.youtubeChannelId || streamer.kickUserId);
  if (!hasOther) return;

  const token = await getValidStreamerAccessToken(streamerTwitchUserId);

  await startTwitchChatListener({
    streamerTwitchUserId,
    channelLogin: streamer.twitchLogin,
    botLogin: streamer.twitchLogin,
    botAccessToken: token,
    onMessage: handleIncomingMessage,
    onDelete: handleMessageDeleted,
  });

  if (streamer.youtubeChannelId) {
    await startYouTubeChatPolling({
      streamerTwitchUserId,
      onMessage: handleIncomingMessage,
      onDelete: handleMessageDeleted,
    });
  }

  if (streamer.kickSlug) {
    let chatroomId = streamer.kickChatroomId;
    if (!chatroomId) {
      try {
        const room = await fetchKickChatroomId(streamer.kickSlug);
        chatroomId = String(room.chatroomId);
        await db
          .update(streamers)
          .set({ kickChatroomId: chatroomId, updatedAt: new Date() })
          .where(eq(streamers.twitchUserId, streamerTwitchUserId));
      } catch (err) {
        console.error(`[kick] chatroom resolve failed for ${streamer.kickSlug}`, err);
      }
    }

    await startKickChatListener({
      streamerTwitchUserId,
      slug: streamer.kickSlug,
      chatroomId,
      onMessage: handleIncomingMessage,
      onDelete: handleMessageDeleted,
    });
  }
}

export async function bootstrapAllRelays() {
  const active = await db.query.streamers.findMany({
    where: eq(streamers.relayEnabled, true),
  });
  for (const s of active) {
    try {
      await syncRelayWorkers(s.twitchUserId);
      console.log(`[relay] started for ${s.twitchLogin}`);
    } catch (err) {
      console.error(`[relay] failed for ${s.twitchLogin}`, err);
    }
  }
}

export async function recentLogsForStreamer(streamerTwitchUserId: string, limit = 30) {
  return db.query.relayLogs.findMany({
    where: eq(relayLogs.streamerTwitchUserId, streamerTwitchUserId),
    orderBy: [desc(relayLogs.createdAt)],
    limit,
  });
}
