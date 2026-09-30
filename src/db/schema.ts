import {
  boolean,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  unique,
  index,
} from "drizzle-orm/pg-core";

export const platformEnum = pgEnum("platform", ["youtube", "kick"]);
export const chatPlatformEnum = pgEnum("chat_platform", ["twitch", "youtube", "kick"]);
export const relayStatusEnum = pgEnum("relay_status", [
  "relayed",
  "skipped_unlinked",
  "skipped_disabled",
  "error",
]);

export const streamers = pgTable("streamers", {
  twitchUserId: text("twitch_user_id").primaryKey(),
  twitchLogin: text("twitch_login").notNull(),
  twitchDisplayName: text("twitch_display_name").notNull(),
  twitchAccessTokenEnc: text("twitch_access_token_enc").notNull(),
  twitchRefreshTokenEnc: text("twitch_refresh_token_enc").notNull(),
  twitchTokenExpiresAt: timestamp("twitch_token_expires_at", { withTimezone: true }),

  youtubeChannelId: text("youtube_channel_id"),
  youtubeChannelTitle: text("youtube_channel_title"),
  youtubeAccessTokenEnc: text("youtube_access_token_enc"),
  youtubeRefreshTokenEnc: text("youtube_refresh_token_enc"),
  youtubeTokenExpiresAt: timestamp("youtube_token_expires_at", { withTimezone: true }),

  kickUserId: text("kick_user_id"),
  kickSlug: text("kick_slug"),
  kickChatroomId: text("kick_chatroom_id"),
  kickAccessTokenEnc: text("kick_access_token_enc"),
  kickRefreshTokenEnc: text("kick_refresh_token_enc"),
  kickTokenExpiresAt: timestamp("kick_token_expires_at", { withTimezone: true }),

  relayEnabled: boolean("relay_enabled").notNull().default(false),
  /** Token secreto da URL do overlay OBS (Browser Source). */
  overlayToken: text("overlay_token").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  twitchUserId: text("twitch_user_id").primaryKey(),
  twitchLogin: text("twitch_login").notNull(),
  twitchDisplayName: text("twitch_display_name").notNull(),
  twitchAccessTokenEnc: text("twitch_access_token_enc").notNull(),
  twitchRefreshTokenEnc: text("twitch_refresh_token_enc").notNull(),
  twitchTokenExpiresAt: timestamp("twitch_token_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const linkedIdentities = pgTable(
  "linked_identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    twitchUserId: text("twitch_user_id")
      .notNull()
      .references(() => users.twitchUserId, { onDelete: "cascade" }),
    platform: platformEnum("platform").notNull(),
    platformUserId: text("platform_user_id").notNull(),
    platformDisplayName: text("platform_display_name"),
    /** Tokens OAuth da plataforma (ex.: Kick chat:write) para postar como o viewer */
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("linked_identities_platform_user_uidx").on(t.platform, t.platformUserId),
    index("linked_identities_twitch_idx").on(t.twitchUserId),
  ],
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  twitchUserId: text("twitch_user_id").notNull(),
  role: text("role").notNull(), // streamer | viewer
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const relayLogs = pgTable(
  "relay_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    streamerTwitchUserId: text("streamer_twitch_user_id")
      .notNull()
      .references(() => streamers.twitchUserId, { onDelete: "cascade" }),
    fromPlatform: text("from_platform").notNull(),
    toPlatform: text("to_platform").notNull(),
    sourceUserId: text("source_user_id"),
    resolvedTwitchUserId: text("resolved_twitch_user_id"),
    messagePreview: text("message_preview"),
    status: relayStatusEnum("status").notNull(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("relay_logs_streamer_created_idx").on(t.streamerTwitchUserId, t.createdAt)],
);

/** IDs irmãos de uma mensagem espelhada pelo relay (para sync de delete). */
export const relayedMessages = pgTable(
  "relayed_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    groupId: uuid("group_id").notNull(),
    streamerTwitchUserId: text("streamer_twitch_user_id")
      .notNull()
      .references(() => streamers.twitchUserId, { onDelete: "cascade" }),
    platform: chatPlatformEnum("platform").notNull(),
    messageId: text("message_id").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("relayed_messages_platform_msg_uidx").on(t.platform, t.messageId),
    index("relayed_messages_group_idx").on(t.groupId),
    index("relayed_messages_streamer_created_idx").on(t.streamerTwitchUserId, t.createdAt),
  ],
);

export type Streamer = typeof streamers.$inferSelect;
export type User = typeof users.$inferSelect;
export type LinkedIdentity = typeof linkedIdentities.$inferSelect;
export type RelayedMessage = typeof relayedMessages.$inferSelect;
