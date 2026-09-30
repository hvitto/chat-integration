import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { env, kickScopes } from "../config.js";
import { db } from "../db/index.js";
import { encryptToken, decryptToken } from "../db/crypto.js";
import { linkedIdentities, streamers } from "../db/schema.js";

const KICK_AUTH = "https://id.kick.com/oauth";
const KICK_API = "https://api.kick.com/public/v1";

function assertKickConfigured() {
  if (!env.KICK_CLIENT_ID || !env.KICK_CLIENT_SECRET) {
    throw new Error("KICK_CLIENT_ID / KICK_CLIENT_SECRET não configurados");
  }
}

/** PKCE (OAuth 2.1) — Kick exige code_challenge S256. */
export function createKickPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function kickAuthorizeUrl(
  state: string,
  codeChallenge: string,
  opts?: { forceConsent?: boolean },
): string {
  assertKickConfigured();
  const params = new URLSearchParams({
    client_id: env.KICK_CLIENT_ID,
    redirect_uri: `${env.APP_URL}/auth/kick/callback`,
    response_type: "code",
    scope: kickScopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  // Garante re-consentimento dos scopes (ex.: moderation:chat_message:manage)
  if (opts?.forceConsent) {
    params.set("prompt", "consent");
  }
  return `${KICK_AUTH}/authorize?${params.toString()}`;
}

interface KickTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

export async function exchangeKickCode(
  code: string,
  codeVerifier: string,
): Promise<KickTokenResponse> {
  assertKickConfigured();
  const res = await fetch(`${KICK_AUTH}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.KICK_CLIENT_ID,
      client_secret: env.KICK_CLIENT_SECRET,
      redirect_uri: `${env.APP_URL}/auth/kick/callback`,
      code,
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`Kick token exchange failed: ${await res.text()}`);
  }
  return res.json() as Promise<KickTokenResponse>;
}

export async function refreshKickToken(refreshToken: string): Promise<KickTokenResponse> {
  assertKickConfigured();
  const res = await fetch(`${KICK_AUTH}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.KICK_CLIENT_ID,
      client_secret: env.KICK_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`Kick refresh failed: ${await res.text()}`);
  }
  return res.json() as Promise<KickTokenResponse>;
}

interface KickUser {
  user_id: number | string;
  name: string;
  email?: string;
}

async function fetchKickUser(accessToken: string): Promise<{ id: string; slug: string; name: string }> {
  const res = await fetch(`${KICK_API}/users`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Kick users failed: ${await res.text()}`);
  }
  const body = (await res.json()) as { data?: KickUser[] } | KickUser[];
  const list = Array.isArray(body) ? body : body.data ?? [];
  const user = list[0];
  if (!user) throw new Error("Kick user not found");
  const id = String(user.user_id);
  const name = user.name;
  return { id, slug: name.toLowerCase(), name };
}

function expiresAt(expiresIn: number): Date {
  return new Date(Date.now() + expiresIn * 1000 - 60_000);
}

export async function linkKickToStreamer(twitchUserId: string, token: KickTokenResponse) {
  const user = await fetchKickUser(token.access_token);
  let kickChatroomId: string | undefined;
  try {
    const { fetchKickChatroomId } = await import("../chat/kick.js");
    const room = await fetchKickChatroomId(user.slug);
    kickChatroomId = String(room.chatroomId);
  } catch (err) {
    console.warn("[kick] não foi possível resolver chatroom no link:", err);
  }

  await db
    .update(streamers)
    .set({
      kickUserId: user.id,
      kickSlug: user.slug,
      kickChatroomId: kickChatroomId ?? undefined,
      kickAccessTokenEnc: encryptToken(token.access_token),
      kickRefreshTokenEnc: token.refresh_token
        ? encryptToken(token.refresh_token)
        : undefined,
      kickTokenExpiresAt: expiresAt(token.expires_in),
      updatedAt: new Date(),
    })
    .where(eq(streamers.twitchUserId, twitchUserId));
  return user;
}

export async function linkKickToViewer(twitchUserId: string, token: KickTokenResponse) {
  const user = await fetchKickUser(token.access_token);
  await db
    .insert(linkedIdentities)
    .values({
      twitchUserId,
      platform: "kick",
      platformUserId: user.id,
      platformDisplayName: user.name,
      accessTokenEnc: encryptToken(token.access_token),
      refreshTokenEnc: token.refresh_token
        ? encryptToken(token.refresh_token)
        : null,
      tokenExpiresAt: expiresAt(token.expires_in),
    })
    .onConflictDoUpdate({
      target: [linkedIdentities.platform, linkedIdentities.platformUserId],
      set: {
        twitchUserId,
        platformDisplayName: user.name,
        accessTokenEnc: encryptToken(token.access_token),
        refreshTokenEnc: token.refresh_token
          ? encryptToken(token.refresh_token)
          : null,
        tokenExpiresAt: expiresAt(token.expires_in),
      },
    });
  return user;
}

export async function unlinkKickFromStreamer(twitchUserId: string) {
  await db
    .update(streamers)
    .set({
      kickUserId: null,
      kickSlug: null,
      kickChatroomId: null,
      kickAccessTokenEnc: null,
      kickRefreshTokenEnc: null,
      kickTokenExpiresAt: null,
      relayEnabled: false,
      updatedAt: new Date(),
    })
    .where(eq(streamers.twitchUserId, twitchUserId));
}

export async function getValidKickAccessTokenForStreamer(
  twitchUserId: string,
): Promise<{ accessToken: string; slug: string | null; kickUserId: string | null }> {
  const streamer = await db.query.streamers.findFirst({
    where: eq(streamers.twitchUserId, twitchUserId),
  });
  if (!streamer?.kickAccessTokenEnc) {
    throw new Error("Kick do streamer não conectado");
  }

  const expires = streamer.kickTokenExpiresAt?.getTime() ?? 0;
  if (expires > Date.now() + 30_000) {
    return {
      accessToken: decryptToken(streamer.kickAccessTokenEnc),
      slug: streamer.kickSlug,
      kickUserId: streamer.kickUserId,
    };
  }

  if (!streamer.kickRefreshTokenEnc) {
    return {
      accessToken: decryptToken(streamer.kickAccessTokenEnc),
      slug: streamer.kickSlug,
      kickUserId: streamer.kickUserId,
    };
  }

  const refreshed = await refreshKickToken(decryptToken(streamer.kickRefreshTokenEnc));
  await db
    .update(streamers)
    .set({
      kickAccessTokenEnc: encryptToken(refreshed.access_token),
      kickRefreshTokenEnc: refreshed.refresh_token
        ? encryptToken(refreshed.refresh_token)
        : streamer.kickRefreshTokenEnc,
      kickTokenExpiresAt: expiresAt(refreshed.expires_in),
      updatedAt: new Date(),
    })
    .where(eq(streamers.twitchUserId, twitchUserId));

  return {
    accessToken: refreshed.access_token,
    slug: streamer.kickSlug,
    kickUserId: streamer.kickUserId,
  };
}

/** Token Kick do viewer (para postar no canal do streamer como ele mesmo). */
export async function getValidKickAccessTokenForViewer(
  twitchUserId: string,
): Promise<{ accessToken: string; kickUserId: string } | null> {
  const identity = await db.query.linkedIdentities.findFirst({
    where: and(
      eq(linkedIdentities.twitchUserId, twitchUserId),
      eq(linkedIdentities.platform, "kick"),
    ),
  });
  if (!identity?.accessTokenEnc || !identity.platformUserId) return null;

  const expires = identity.tokenExpiresAt?.getTime() ?? 0;
  if (expires > Date.now() + 30_000) {
    return {
      accessToken: decryptToken(identity.accessTokenEnc),
      kickUserId: identity.platformUserId,
    };
  }

  if (!identity.refreshTokenEnc) {
    return {
      accessToken: decryptToken(identity.accessTokenEnc),
      kickUserId: identity.platformUserId,
    };
  }

  const refreshed = await refreshKickToken(decryptToken(identity.refreshTokenEnc));
  await db
    .update(linkedIdentities)
    .set({
      accessTokenEnc: encryptToken(refreshed.access_token),
      refreshTokenEnc: refreshed.refresh_token
        ? encryptToken(refreshed.refresh_token)
        : identity.refreshTokenEnc,
      tokenExpiresAt: expiresAt(refreshed.expires_in),
    })
    .where(eq(linkedIdentities.id, identity.id));

  return {
    accessToken: refreshed.access_token,
    kickUserId: identity.platformUserId,
  };
}

export async function sendKickChatMessage(
  accessToken: string,
  broadcasterUserId: string,
  content: string,
): Promise<{ messageId: string }> {
  console.log(
    `[kick] SEND pid=${process.pid} broadcaster=${broadcasterUserId} text=${content.slice(0, 60)}`,
  );
  const res = await fetch(`${KICK_API}/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      broadcaster_user_id: Number(broadcasterUserId),
      content,
      type: "user",
    }),
  });
  if (!res.ok) {
    throw new Error(`Kick send chat failed: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    data?: { message_id?: string; is_sent?: boolean };
  };
  const messageId = body.data?.message_id;
  if (!messageId) throw new Error("Kick send chat: message_id ausente");
  console.log(`[kick] SENT ok id=${messageId} pid=${process.pid}`);
  return { messageId };
}

export async function deleteKickChatMessage(
  accessToken: string,
  messageId: string,
): Promise<void> {
  const res = await fetch(`${KICK_API}/chat/${encodeURIComponent(messageId)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  // 204 No Content = sucesso
  if (res.ok || res.status === 404) return;
  const body = await res.text();
  if (res.status === 401) {
    throw new Error(
      `Kick delete Unauthorized (falta scope moderation:chat_message:manage — reconecte a Kick no painel): ${body}`,
    );
  }
  throw new Error(`Kick delete chat failed (${res.status}): ${body}`);
}
