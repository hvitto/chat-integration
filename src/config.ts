import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(16),
  TOKEN_ENCRYPTION_KEY: z.string().length(64), // 32 bytes hex

  TWITCH_CLIENT_ID: z.string().min(1),
  TWITCH_CLIENT_SECRET: z.string().min(1),

  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(""),

  KICK_CLIENT_ID: z.string().optional().default(""),
  KICK_CLIENT_SECRET: z.string().optional().default(""),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

export const env = parsed.data;

export const twitchScopes = {
  streamer: [
    "user:read:email",
    "chat:read",
    "chat:edit",
    "user:write:chat",
    "user:bot",
    "channel:bot",
    "moderator:read:followers",
    "moderator:manage:chat_messages",
  ].join(" "),
  viewer: [
    "user:read:email",
    "chat:read",
    "chat:edit",
    "user:write:chat",
  ].join(" "),
};

export const youtubeScopes = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.force-ssl",
].join(" ");

export const kickScopes = [
  "user:read",
  "channel:read",
  "chat:write",
  "moderation:chat_message:manage",
].join(" ");
