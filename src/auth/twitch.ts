import { eq } from "drizzle-orm";
import { env, twitchScopes } from "../config.js";
import { db } from "../db/index.js";
import { encryptToken, decryptToken } from "../db/crypto.js";
import { streamers, users } from "../db/schema.js";
import type { SessionRole } from "./session.js";

const TWITCH_AUTH = "https://id.twitch.tv/oauth2";
const TWITCH_API = "https://api.twitch.tv/helix";

export function twitchAuthorizeUrl(role: SessionRole, state: string): string {
  const scopes = role === "streamer" ? twitchScopes.streamer : twitchScopes.viewer;
  const params = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    redirect_uri: `${env.APP_URL}/auth/twitch/callback`,
    response_type: "code",
    scope: scopes,
    state: `${role}:${state}`,
  });
  return `${TWITCH_AUTH}/authorize?${params.toString()}`;
}

interface TwitchTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string[];
  token_type: string;
}

interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
}

export async function exchangeTwitchCode(code: string): Promise<TwitchTokenResponse> {
  const res = await fetch(`${TWITCH_AUTH}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: `${env.APP_URL}/auth/twitch/callback`,
    }),
  });
  if (!res.ok) {
    throw new Error(`Twitch token exchange failed: ${await res.text()}`);
  }
  return res.json() as Promise<TwitchTokenResponse>;
}

export async function refreshTwitchToken(refreshToken: string): Promise<TwitchTokenResponse> {
  const res = await fetch(`${TWITCH_AUTH}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`Twitch refresh failed: ${await res.text()}`);
  }
  return res.json() as Promise<TwitchTokenResponse>;
}

export async function fetchTwitchUser(accessToken: string): Promise<TwitchUser> {
  const res = await fetch(`${TWITCH_API}/users`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Client-Id": env.TWITCH_CLIENT_ID,
    },
  });
  if (!res.ok) {
    throw new Error(`Twitch users failed: ${await res.text()}`);
  }
  const data = (await res.json()) as { data: TwitchUser[] };
  if (!data.data?.[0]) throw new Error("Twitch user not found");
  return data.data[0];
}

function expiresAt(expiresIn: number): Date {
  return new Date(Date.now() + expiresIn * 1000 - 60_000);
}

export async function upsertStreamerFromTwitch(
  token: TwitchTokenResponse,
  user: TwitchUser,
) {
  const values = {
    twitchUserId: user.id,
    twitchLogin: user.login,
    twitchDisplayName: user.display_name,
    twitchAccessTokenEnc: encryptToken(token.access_token),
    twitchRefreshTokenEnc: encryptToken(token.refresh_token),
    twitchTokenExpiresAt: expiresAt(token.expires_in),
    updatedAt: new Date(),
  };

  await db
    .insert(streamers)
    .values({ ...values, relayEnabled: false })
    .onConflictDoUpdate({
      target: streamers.twitchUserId,
      set: values,
    });

  // Streamer also gets a viewer user record so they can chat as themselves
  await upsertViewerFromTwitch(token, user);
}

export async function upsertViewerFromTwitch(
  token: TwitchTokenResponse,
  user: TwitchUser,
) {
  const values = {
    twitchUserId: user.id,
    twitchLogin: user.login,
    twitchDisplayName: user.display_name,
    twitchAccessTokenEnc: encryptToken(token.access_token),
    twitchRefreshTokenEnc: encryptToken(token.refresh_token),
    twitchTokenExpiresAt: expiresAt(token.expires_in),
    updatedAt: new Date(),
  };

  await db.insert(users).values(values).onConflictDoUpdate({
    target: users.twitchUserId,
    set: values,
  });
}

export async function getValidViewerAccessToken(twitchUserId: string): Promise<string> {
  const user = await db.query.users.findFirst({
    where: eq(users.twitchUserId, twitchUserId),
  });
  if (!user) throw new Error("Viewer não encontrado");

  const expires = user.twitchTokenExpiresAt?.getTime() ?? 0;
  if (expires > Date.now() + 30_000) {
    return decryptToken(user.twitchAccessTokenEnc);
  }

  const refreshed = await refreshTwitchToken(decryptToken(user.twitchRefreshTokenEnc));
  await db
    .update(users)
    .set({
      twitchAccessTokenEnc: encryptToken(refreshed.access_token),
      twitchRefreshTokenEnc: encryptToken(refreshed.refresh_token),
      twitchTokenExpiresAt: expiresAt(refreshed.expires_in),
      updatedAt: new Date(),
    })
    .where(eq(users.twitchUserId, twitchUserId));

  return refreshed.access_token;
}

export async function getValidStreamerAccessToken(twitchUserId: string): Promise<string> {
  const streamer = await db.query.streamers.findFirst({
    where: eq(streamers.twitchUserId, twitchUserId),
  });
  if (!streamer) throw new Error("Streamer não encontrado");

  const expires = streamer.twitchTokenExpiresAt?.getTime() ?? 0;
  if (expires > Date.now() + 30_000) {
    return decryptToken(streamer.twitchAccessTokenEnc);
  }

  const refreshed = await refreshTwitchToken(decryptToken(streamer.twitchRefreshTokenEnc));
  await db
    .update(streamers)
    .set({
      twitchAccessTokenEnc: encryptToken(refreshed.access_token),
      twitchRefreshTokenEnc: encryptToken(refreshed.refresh_token),
      twitchTokenExpiresAt: expiresAt(refreshed.expires_in),
      updatedAt: new Date(),
    })
    .where(eq(streamers.twitchUserId, twitchUserId));

  return refreshed.access_token;
}
