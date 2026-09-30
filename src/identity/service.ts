import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { linkedIdentities, users } from "../db/schema.js";

export async function findTwitchUserByPlatformIdentity(
  platform: "youtube" | "kick",
  platformUserId: string,
) {
  const identity = await db.query.linkedIdentities.findFirst({
    where: and(
      eq(linkedIdentities.platform, platform),
      eq(linkedIdentities.platformUserId, platformUserId),
    ),
  });
  if (!identity) return null;

  const user = await db.query.users.findFirst({
    where: eq(users.twitchUserId, identity.twitchUserId),
  });
  return user ?? null;
}

export async function listIdentitiesForUser(twitchUserId: string) {
  return db.query.linkedIdentities.findMany({
    where: eq(linkedIdentities.twitchUserId, twitchUserId),
  });
}

export async function unlinkIdentity(
  twitchUserId: string,
  platform: "youtube" | "kick",
) {
  await db
    .delete(linkedIdentities)
    .where(
      and(
        eq(linkedIdentities.twitchUserId, twitchUserId),
        eq(linkedIdentities.platform, platform),
      ),
    );
}
