import type { ChatPlatform } from "../relay/messages.js";
import {
  buildFragments,
  mergeEmoteSpans,
  type ChatBadge,
  type ChatFragment,
  type ChatStyleMeta,
} from "../chat/meta.js";
import { enrichWithSevenTv } from "../chat/seventv.js";
import type { IncomingChatMessage } from "../chat/twitch.js";

export type OverlayMessageEvent = {
  type: "message";
  platform: ChatPlatform;
  messageId: string;
  displayName: string;
  message: string;
  linked?: boolean;
  color?: string;
  badges?: ChatBadge[];
  fragments?: ChatFragment[];
  sevenTvColor?: string;
  sevenTvPaintCss?: string;
};

export async function buildOverlayMessage(params: {
  platform: ChatPlatform;
  messageId: string;
  displayName: string;
  message: string;
  linked?: boolean;
  meta?: ChatStyleMeta;
  /** User Twitch para paint/cor 7TV — só se não houver cor nativa da origem */
  styleTwitchUserId?: string;
  streamerTwitchUserId: string;
  /** Se true, não aplica cor/paint 7TV no nick (origem Kick/YT) */
  preferNativeColor?: boolean;
}): Promise<OverlayMessageEvent> {
  let emotes = params.meta?.emotes ?? [];
  let sevenTvColor = params.meta?.sevenTvColor;
  let sevenTvPaintCss = params.meta?.sevenTvPaintCss;
  const hasNativeColor = Boolean(params.meta?.color);
  const wantSevenTvStyle =
    !params.preferNativeColor && !hasNativeColor && Boolean(params.styleTwitchUserId);

  try {
    const stv = await enrichWithSevenTv({
      streamerTwitchUserId: params.streamerTwitchUserId,
      styleTwitchUserId: wantSevenTvStyle ? params.styleTwitchUserId : undefined,
      message: params.message,
      emotes,
    });
    emotes = stv.emotes;
    if (wantSevenTvStyle) {
      sevenTvColor = stv.sevenTvColor ?? sevenTvColor;
      sevenTvPaintCss = stv.sevenTvPaintCss ?? sevenTvPaintCss;
    }
  } catch (err) {
    console.error("[7tv] enrich failed", err);
  }

  return {
    type: "message",
    platform: params.platform,
    messageId: params.messageId,
    displayName: params.displayName,
    message: params.message,
    linked: params.linked,
    color: params.meta?.color,
    badges: params.meta?.badges,
    fragments: buildFragments(params.message, emotes),
    sevenTvColor: hasNativeColor ? undefined : sevenTvColor,
    sevenTvPaintCss: hasNativeColor ? undefined : sevenTvPaintCss,
  };
}

export function metaFromIncoming(msg: IncomingChatMessage): ChatStyleMeta {
  return {
    color: msg.color,
    badges: msg.badges,
    emotes: msg.emotes,
  };
}

export function mergeOriginWithTwitchEmotes(
  origin: ChatStyleMeta | undefined,
  twitch: ChatStyleMeta,
): ChatStyleMeta {
  return {
    color: origin?.color,
    badges: origin?.badges?.length ? origin.badges : undefined,
    emotes: mergeEmoteSpans(origin?.emotes ?? [], twitch.emotes ?? []),
  };
}
