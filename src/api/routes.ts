import { randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { env } from "../config.js";
import { db } from "../db/index.js";
import { streamers, users } from "../db/schema.js";
import {
  createSession,
  destroySession,
  requireSession,
  type SessionRole,
} from "../auth/session.js";
import {
  exchangeTwitchCode,
  fetchTwitchUser,
  twitchAuthorizeUrl,
  upsertStreamerFromTwitch,
  upsertViewerFromTwitch,
} from "../auth/twitch.js";
import {
  exchangeYouTubeCode,
  linkYouTubeToStreamer,
  linkYouTubeToViewer,
  unlinkYouTubeFromStreamer,
  youtubeAuthorizeUrl,
} from "../auth/youtube.js";
import {
  createKickPkce,
  exchangeKickCode,
  kickAuthorizeUrl,
  linkKickToStreamer,
  linkKickToViewer,
  unlinkKickFromStreamer,
} from "../auth/kick.js";
import { listIdentitiesForUser, unlinkIdentity } from "../identity/service.js";
import { recentLogsForStreamer, syncRelayWorkers } from "../relay/service.js";
import { subscribeOverlay } from "../overlay/bus.js";

const oauthStates = new Map<string, { createdAt: number; codeVerifier?: string }>();

function putState(extra?: { codeVerifier?: string }): string {
  const state = randomBytes(16).toString("hex");
  oauthStates.set(state, { createdAt: Date.now(), ...extra });
  return state;
}

function takeState(state: string): { ok: boolean; codeVerifier?: string } {
  const row = oauthStates.get(state);
  oauthStates.delete(state);
  if (!row) return { ok: false };
  if (Date.now() - row.createdAt > 10 * 60 * 1000) return { ok: false };
  return { ok: true, codeVerifier: row.codeVerifier };
}

export const apiRouter = Router();

apiRouter.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

apiRouter.get("/api/me", async (req, res) => {
  if (!req.sessionUser) {
    return res.json({ authenticated: false });
  }

  const { twitchUserId, role } = req.sessionUser;

  if (role === "streamer") {
    const streamer = await db.query.streamers.findFirst({
      where: eq(streamers.twitchUserId, twitchUserId),
    });
    if (!streamer) return res.json({ authenticated: false });
    return res.json({
      authenticated: true,
      role,
      twitchUserId: streamer.twitchUserId,
      twitchLogin: streamer.twitchLogin,
      twitchDisplayName: streamer.twitchDisplayName,
      youtube: streamer.youtubeChannelId
        ? { connected: true, title: streamer.youtubeChannelTitle, id: streamer.youtubeChannelId }
        : { connected: false },
      kick: streamer.kickUserId
        ? { connected: true, slug: streamer.kickSlug, id: streamer.kickUserId }
        : { connected: false },
      relayEnabled: streamer.relayEnabled,
      audienceLink: `${env.APP_URL}/link?streamer=${encodeURIComponent(streamer.twitchLogin)}`,
      overlayUrl: streamer.overlayToken
        ? `${env.APP_URL}/overlay?token=${encodeURIComponent(streamer.overlayToken)}`
        : null,
    });
  }

  const user = await db.query.users.findFirst({
    where: eq(users.twitchUserId, twitchUserId),
  });
  if (!user) return res.json({ authenticated: false });
  const identities = await listIdentitiesForUser(twitchUserId);
  return res.json({
    authenticated: true,
    role,
    twitchUserId: user.twitchUserId,
    twitchLogin: user.twitchLogin,
    twitchDisplayName: user.twitchDisplayName,
    identities: identities.map((i) => ({
      platform: i.platform,
      platformUserId: i.platformUserId,
      platformDisplayName: i.platformDisplayName,
    })),
  });
});

apiRouter.get("/auth/twitch", (req, res) => {
  const role = (req.query.role as SessionRole) === "viewer" ? "viewer" : "streamer";
  const state = putState();
  res.redirect(twitchAuthorizeUrl(role, state));
});

apiRouter.get("/auth/twitch/callback", async (req, res) => {
  try {
    const code = String(req.query.code ?? "");
    const stateRaw = String(req.query.state ?? "");
    const [role, state] = stateRaw.split(":") as [SessionRole, string];
    if (!code || !state || !takeState(state).ok || (role !== "streamer" && role !== "viewer")) {
      return res.status(400).send("OAuth state inválido");
    }
    const token = await exchangeTwitchCode(code);
    const user = await fetchTwitchUser(token.access_token);
    if (role === "streamer") {
      await upsertStreamerFromTwitch(token, user);
    } else {
      await upsertViewerFromTwitch(token, user);
    }
    await createSession(res, user.id, role);
    res.redirect(role === "streamer" ? "/dashboard" : "/link");
  } catch (err) {
    console.error(err);
    res.status(500).send("Falha no login Twitch");
  }
});

apiRouter.post("/auth/logout", async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

apiRouter.get("/auth/youtube", requireSession(), (req, res) => {
  try {
    const intent = req.query.intent === "viewer" ? "viewer" : "streamer";
    if (intent === "streamer" && req.sessionUser!.role !== "streamer") {
      return res.status(403).send("Apenas streamer");
    }
    const state = `${intent}:${req.sessionUser!.twitchUserId}:${putState()}`;
    res.redirect(youtubeAuthorizeUrl(state));
  } catch (err) {
    res.status(500).send(err instanceof Error ? err.message : "Erro YouTube OAuth");
  }
});

apiRouter.get("/auth/youtube/callback", async (req, res) => {
  try {
    const code = String(req.query.code ?? "");
    const stateRaw = String(req.query.state ?? "");
    const [intent, twitchUserId, state] = stateRaw.split(":");
    if (!code || !state || !takeState(state).ok || !twitchUserId) {
      return res.status(400).send("OAuth state inválido");
    }
    if (!req.sessionUser || req.sessionUser.twitchUserId !== twitchUserId) {
      return res.status(401).send("Sessão inválida");
    }
    const tokens = await exchangeYouTubeCode(code);
    if (intent === "streamer") {
      await linkYouTubeToStreamer(twitchUserId, tokens);
      await syncRelayWorkers(twitchUserId);
      return res.redirect("/dashboard");
    }
    await linkYouTubeToViewer(twitchUserId, tokens);
    return res.redirect("/link");
  } catch (err) {
    console.error(err);
    res.status(500).send("Falha ao conectar YouTube");
  }
});

apiRouter.get("/auth/kick", requireSession(), (req, res) => {
  try {
    const intent = req.query.intent === "viewer" ? "viewer" : "streamer";
    if (intent === "streamer" && req.sessionUser!.role !== "streamer") {
      return res.status(403).send("Apenas streamer");
    }
    const pkce = createKickPkce();
    const nonce = putState({ codeVerifier: pkce.verifier });
    const state = `${intent}:${req.sessionUser!.twitchUserId}:${nonce}`;
    const forceConsent =
      intent === "streamer" ||
      req.query.reauth === "1" ||
      req.query.reauth === "true";
    res.redirect(
      kickAuthorizeUrl(state, pkce.challenge, { forceConsent }),
    );
  } catch (err) {
    res.status(500).send(err instanceof Error ? err.message : "Erro Kick OAuth");
  }
});

apiRouter.get("/auth/kick/callback", async (req, res) => {
  try {
    const code = String(req.query.code ?? "");
    const stateRaw = String(req.query.state ?? "");
    const [intent, twitchUserId, state] = stateRaw.split(":");
    const taken = state ? takeState(state) : { ok: false as const };
    if (!code || !state || !taken.ok || !taken.codeVerifier || !twitchUserId) {
      return res.status(400).send("OAuth state inválido");
    }
    if (!req.sessionUser || req.sessionUser.twitchUserId !== twitchUserId) {
      return res.status(401).send("Sessão inválida");
    }
    const token = await exchangeKickCode(code, taken.codeVerifier);
    if (intent === "streamer") {
      await linkKickToStreamer(twitchUserId, token);
      await syncRelayWorkers(twitchUserId);
      return res.redirect("/dashboard");
    }
    await linkKickToViewer(twitchUserId, token);
    return res.redirect("/link");
  } catch (err) {
    console.error(err);
    res.status(500).send("Falha ao conectar Kick");
  }
});

apiRouter.post(
  "/api/streamer/relay",
  requireSession("streamer"),
  async (req: Request, res: Response) => {
    const enabled = Boolean(req.body?.enabled);
    const streamer = await db.query.streamers.findFirst({
      where: eq(streamers.twitchUserId, req.sessionUser!.twitchUserId),
    });
    if (!streamer) return res.status(404).json({ error: "Streamer não encontrado" });

    if (enabled && !streamer.youtubeChannelId && !streamer.kickUserId) {
      return res.status(400).json({
        error: "Conecte YouTube ou Kick antes de ativar o relay",
      });
    }

    await db
      .update(streamers)
      .set({ relayEnabled: enabled, updatedAt: new Date() })
      .where(eq(streamers.twitchUserId, streamer.twitchUserId));

    await syncRelayWorkers(streamer.twitchUserId);
    res.json({ relayEnabled: enabled });
  },
);

apiRouter.post(
  "/api/streamer/disconnect/:platform",
  requireSession("streamer"),
  async (req, res) => {
    const platform = req.params.platform;
    const id = req.sessionUser!.twitchUserId;
    if (platform === "youtube") await unlinkYouTubeFromStreamer(id);
    else if (platform === "kick") await unlinkKickFromStreamer(id);
    else return res.status(400).json({ error: "Plataforma inválida" });
    await syncRelayWorkers(id);
    res.json({ ok: true });
  },
);

apiRouter.get("/api/streamer/logs", requireSession("streamer"), async (req, res) => {
  const logs = await recentLogsForStreamer(req.sessionUser!.twitchUserId);
  res.json({ logs });
});

apiRouter.post(
  "/api/streamer/overlay/token",
  requireSession("streamer"),
  async (req, res) => {
    const token = randomBytes(24).toString("hex");
    await db
      .update(streamers)
      .set({ overlayToken: token, updatedAt: new Date() })
      .where(eq(streamers.twitchUserId, req.sessionUser!.twitchUserId));
    res.json({
      overlayToken: token,
      overlayUrl: `${env.APP_URL}/overlay?token=${encodeURIComponent(token)}`,
    });
  },
);

apiRouter.get("/api/overlay/me", async (req, res) => {
  const token = String(req.query.token ?? "");
  if (!token) return res.status(401).json({ error: "Token ausente" });
  const streamer = await db.query.streamers.findFirst({
    where: eq(streamers.overlayToken, token),
  });
  if (!streamer) return res.status(401).json({ error: "Token inválido" });
  res.json({
    twitchLogin: streamer.twitchLogin,
    twitchDisplayName: streamer.twitchDisplayName,
    youtube: Boolean(streamer.youtubeChannelId),
    kick: Boolean(streamer.kickUserId),
    relayEnabled: streamer.relayEnabled,
  });
});

apiRouter.get("/api/overlay/stream", async (req, res) => {
  const token = String(req.query.token ?? "");
  if (!token) return res.status(401).json({ error: "Token ausente" });
  const streamer = await db.query.streamers.findFirst({
    where: eq(streamers.overlayToken, token),
  });
  if (!streamer) return res.status(401).json({ error: "Token inválido" });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event: unknown) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  send({ type: "hello", twitchLogin: streamer.twitchLogin });

  const unsubscribe = subscribeOverlay(streamer.twitchUserId, (event) => {
    send(event);
  });

  const heartbeat = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

apiRouter.post(
  "/api/viewer/unlink/:platform",
  requireSession("viewer"),
  async (req, res) => {
    const platform = req.params.platform;
    if (platform !== "youtube" && platform !== "kick") {
      return res.status(400).json({ error: "Plataforma inválida" });
    }
    await unlinkIdentity(req.sessionUser!.twitchUserId, platform);
    res.json({ ok: true });
  },
);

apiRouter.get("/api/streamer/by-login/:login", async (req, res) => {
  const login = req.params.login.toLowerCase();
  const streamer = await db.query.streamers.findFirst({
    where: eq(streamers.twitchLogin, login),
  });
  if (!streamer) return res.status(404).json({ error: "Streamer não encontrado" });
  res.json({
    twitchLogin: streamer.twitchLogin,
    twitchDisplayName: streamer.twitchDisplayName,
    relayEnabled: streamer.relayEnabled,
  });
});
