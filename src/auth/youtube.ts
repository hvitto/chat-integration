import { google, type youtube_v3 } from "googleapis";
import { and, eq, sql } from "drizzle-orm";
import { env, youtubeScopes } from "../config.js";
import { db } from "../db/index.js";
import { encryptToken, decryptToken } from "../db/crypto.js";
import { linkedIdentities, streamers } from "../db/schema.js";

function oauthClient() {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET não configurados");
  }
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    `${env.APP_URL}/auth/youtube/callback`,
  );
}

export function youtubeAuthorizeUrl(state: string): string {
  const client = oauthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: youtubeScopes.split(" "),
    state,
  });
}

export async function exchangeYouTubeCode(code: string) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token) throw new Error("YouTube: access_token ausente");
  return tokens;
}

async function getChannelInfo(accessToken: string, refreshToken?: string | null) {
  const client = oauthClient();
  client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken ?? undefined,
  });
  const youtube = google.youtube({ version: "v3", auth: client });
  const res = await youtube.channels.list({
    part: ["snippet"],
    mine: true,
  });
  const channel = res.data.items?.[0];
  if (!channel?.id) throw new Error("Canal YouTube não encontrado");
  return {
    id: channel.id,
    title: channel.snippet?.title ?? channel.id,
  };
}

function expiresAt(expiryDate?: number | null): Date | null {
  if (!expiryDate) return null;
  return new Date(expiryDate);
}

export async function linkYouTubeToStreamer(
  twitchUserId: string,
  tokens: Awaited<ReturnType<typeof exchangeYouTubeCode>>,
) {
  const channel = await getChannelInfo(tokens.access_token!, tokens.refresh_token);
  await db
    .update(streamers)
    .set({
      youtubeChannelId: channel.id,
      youtubeChannelTitle: channel.title,
      youtubeAccessTokenEnc: encryptToken(tokens.access_token!),
      youtubeRefreshTokenEnc: tokens.refresh_token
        ? encryptToken(tokens.refresh_token)
        : undefined,
      youtubeTokenExpiresAt: expiresAt(tokens.expiry_date),
      updatedAt: new Date(),
    })
    .where(eq(streamers.twitchUserId, twitchUserId));
  return channel;
}

export async function linkYouTubeToViewer(
  twitchUserId: string,
  tokens: Awaited<ReturnType<typeof exchangeYouTubeCode>>,
) {
  const channel = await getChannelInfo(tokens.access_token!, tokens.refresh_token);
  await db
    .insert(linkedIdentities)
    .values({
      twitchUserId,
      platform: "youtube",
      platformUserId: channel.id,
      platformDisplayName: channel.title,
      accessTokenEnc: encryptToken(tokens.access_token!),
      refreshTokenEnc: tokens.refresh_token
        ? encryptToken(tokens.refresh_token)
        : null,
      tokenExpiresAt: expiresAt(tokens.expiry_date),
    })
    .onConflictDoUpdate({
      target: [linkedIdentities.platform, linkedIdentities.platformUserId],
      set: {
        twitchUserId,
        platformDisplayName: channel.title,
        accessTokenEnc: encryptToken(tokens.access_token!),
        refreshTokenEnc: tokens.refresh_token
          ? encryptToken(tokens.refresh_token)
          : null,
        tokenExpiresAt: expiresAt(tokens.expiry_date),
      },
    });
  return channel;
}

export async function unlinkYouTubeFromStreamer(twitchUserId: string) {
  await db
    .update(streamers)
    .set({
      youtubeChannelId: null,
      youtubeChannelTitle: null,
      youtubeAccessTokenEnc: null,
      youtubeRefreshTokenEnc: null,
      youtubeTokenExpiresAt: null,
      relayEnabled: sql`${streamers.relayEnabled} and ${streamers.kickUserId} is not null`,
      updatedAt: new Date(),
    })
    .where(eq(streamers.twitchUserId, twitchUserId));
}

export async function getStreamerYouTubeClient(twitchUserId: string) {
  const streamer = await db.query.streamers.findFirst({
    where: eq(streamers.twitchUserId, twitchUserId),
  });
  if (!streamer?.youtubeAccessTokenEnc) {
    throw new Error("YouTube do streamer não conectado");
  }

  const client = oauthClient();
  client.setCredentials({
    access_token: decryptToken(streamer.youtubeAccessTokenEnc),
    refresh_token: streamer.youtubeRefreshTokenEnc
      ? decryptToken(streamer.youtubeRefreshTokenEnc)
      : undefined,
    expiry_date: streamer.youtubeTokenExpiresAt?.getTime(),
  });

  client.on("tokens", async (tokens) => {
    await db
      .update(streamers)
      .set({
        youtubeAccessTokenEnc: tokens.access_token
          ? encryptToken(tokens.access_token)
          : undefined,
        youtubeRefreshTokenEnc: tokens.refresh_token
          ? encryptToken(tokens.refresh_token)
          : undefined,
        youtubeTokenExpiresAt: expiresAt(tokens.expiry_date),
        updatedAt: new Date(),
      })
      .where(eq(streamers.twitchUserId, twitchUserId));
  });

  return { client, streamer, youtube: google.youtube({ version: "v3", auth: client }) };
}

/** Cliente YouTube do viewer (para postar no liveChat do streamer como ele mesmo). */
export async function getViewerYouTubeClient(
  twitchUserId: string,
): Promise<{ youtube: youtube_v3.Youtube; channelId: string } | null> {
  const identity = await db.query.linkedIdentities.findFirst({
    where: and(
      eq(linkedIdentities.twitchUserId, twitchUserId),
      eq(linkedIdentities.platform, "youtube"),
    ),
  });
  if (!identity?.accessTokenEnc || !identity.platformUserId) return null;

  const client = oauthClient();
  client.setCredentials({
    access_token: decryptToken(identity.accessTokenEnc),
    refresh_token: identity.refreshTokenEnc
      ? decryptToken(identity.refreshTokenEnc)
      : undefined,
    expiry_date: identity.tokenExpiresAt?.getTime(),
  });

  client.on("tokens", async (tokens) => {
    await db
      .update(linkedIdentities)
      .set({
        accessTokenEnc: tokens.access_token
          ? encryptToken(tokens.access_token)
          : identity.accessTokenEnc,
        refreshTokenEnc: tokens.refresh_token
          ? encryptToken(tokens.refresh_token)
          : identity.refreshTokenEnc,
        tokenExpiresAt: expiresAt(tokens.expiry_date),
      })
      .where(eq(linkedIdentities.id, identity.id));
  });

  return {
    youtube: google.youtube({ version: "v3", auth: client }),
    channelId: identity.platformUserId,
  };
}
