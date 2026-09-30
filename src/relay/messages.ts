import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { relayedMessages } from "../db/schema.js";

export type ChatPlatform = "twitch" | "youtube" | "kick";

const TTL_MS = 6 * 60 * 60 * 1000; // Twitch delete window ~6h

export function newRelayGroupId(): string {
  return randomUUID();
}

export async function recordRelayedMessage(entry: {
  groupId: string;
  streamerTwitchUserId: string;
  platform: ChatPlatform;
  messageId: string;
}): Promise<void> {
  if (!entry.messageId) return;
  await db
    .insert(relayedMessages)
    .values({
      groupId: entry.groupId,
      streamerTwitchUserId: entry.streamerTwitchUserId,
      platform: entry.platform,
      messageId: entry.messageId,
    })
    .onConflictDoNothing();
}

export async function recordRelayedGroup(params: {
  groupId: string;
  streamerTwitchUserId: string;
  messages: Array<{ platform: ChatPlatform; messageId: string }>;
}): Promise<void> {
  for (const m of params.messages) {
    await recordRelayedMessage({
      groupId: params.groupId,
      streamerTwitchUserId: params.streamerTwitchUserId,
      platform: m.platform,
      messageId: m.messageId,
    });
  }
}

/** Mensagens irmãs ainda ativas no grupo (exclui a origem do evento). */
export async function findSiblingMessages(params: {
  platform: ChatPlatform;
  messageId: string;
  streamerTwitchUserId: string;
}): Promise<{
  groupId: string;
  siblings: Array<{ platform: ChatPlatform; messageId: string }>;
} | null> {
  const cutoff = new Date(Date.now() - TTL_MS);
  const row = await db.query.relayedMessages.findFirst({
    where: and(
      eq(relayedMessages.platform, params.platform),
      eq(relayedMessages.messageId, params.messageId),
      eq(relayedMessages.streamerTwitchUserId, params.streamerTwitchUserId),
      gt(relayedMessages.createdAt, cutoff),
    ),
  });
  if (!row) return null;

  // Já propagamos delete neste grupo
  if (row.deletedAt) return null;

  const all = await db.query.relayedMessages.findMany({
    where: and(
      eq(relayedMessages.groupId, row.groupId),
      isNull(relayedMessages.deletedAt),
    ),
  });

  const siblings = all
    .filter(
      (m) =>
        !(m.platform === params.platform && m.messageId === params.messageId),
    )
    .map((m) => ({
      platform: m.platform as ChatPlatform,
      messageId: m.messageId,
    }));

  return { groupId: row.groupId, siblings };
}

export async function markGroupDeleted(groupId: string): Promise<void> {
  await db
    .update(relayedMessages)
    .set({ deletedAt: new Date() })
    .where(eq(relayedMessages.groupId, groupId));
}
