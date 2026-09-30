import { randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { eq, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { sessions } from "../db/schema.js";

const COOKIE_NAME = "cid_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

export type SessionRole = "streamer" | "viewer";

export interface SessionUser {
  sessionId: string;
  twitchUserId: string;
  role: SessionRole;
}

declare global {
  namespace Express {
    interface Request {
      sessionUser?: SessionUser;
    }
  }
}

export async function createSession(
  res: Response,
  twitchUserId: string,
  role: SessionRole,
): Promise<string> {
  const id = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    id,
    twitchUserId,
    role,
    expiresAt,
  });
  res.cookie(COOKIE_NAME, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
  return id;
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  const id = req.cookies?.[COOKIE_NAME] as string | undefined;
  if (id) {
    await db.delete(sessions).where(eq(sessions.id, id));
  }
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

export async function loadSession(req: Request, _res: Response, next: NextFunction) {
  try {
    const id = req.cookies?.[COOKIE_NAME] as string | undefined;
    if (!id) return next();

    const row = await db.query.sessions.findFirst({
      where: eq(sessions.id, id),
    });

    if (!row || row.expiresAt.getTime() < Date.now()) {
      if (row) await db.delete(sessions).where(eq(sessions.id, id));
      return next();
    }

    req.sessionUser = {
      sessionId: row.id,
      twitchUserId: row.twitchUserId,
      role: row.role as SessionRole,
    };
    next();
  } catch (err) {
    next(err);
  }
}

export function requireSession(role?: SessionRole) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.sessionUser) {
      return res.status(401).json({ error: "Não autenticado" });
    }
    if (role && req.sessionUser.role !== role) {
      return res.status(403).json({ error: `Sessão precisa ser ${role}` });
    }
    next();
  };
}

export async function cleanupExpiredSessions() {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
