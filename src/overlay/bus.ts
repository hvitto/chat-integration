import type { ChatPlatform } from "../relay/messages.js";
import type { OverlayMessageEvent } from "./format.js";
import type { ChatBadge, ChatFragment } from "../chat/meta.js";

export type OverlayEvent =
  | OverlayMessageEvent
  | {
      type: "delete";
      platform: ChatPlatform;
      messageId: string;
    };

// Re-export for consumers
export type { ChatBadge, ChatFragment, OverlayMessageEvent };

type Listener = (event: OverlayEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function subscribeOverlay(
  streamerTwitchUserId: string,
  listener: Listener,
): () => void {
  let set = listeners.get(streamerTwitchUserId);
  if (!set) {
    set = new Set();
    listeners.set(streamerTwitchUserId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(streamerTwitchUserId);
  };
}

export function publishOverlay(
  streamerTwitchUserId: string,
  event: OverlayEvent,
): void {
  const set = listeners.get(streamerTwitchUserId);
  if (!set?.size) return;
  for (const listener of set) {
    try {
      listener(event);
    } catch (err) {
      console.error("[overlay bus]", err);
    }
  }
}
