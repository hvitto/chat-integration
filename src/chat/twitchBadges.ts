import { env } from "../config.js";
import type { ChatBadge } from "./meta.js";

type HelixBadgeVersion = {
  id: string;
  title?: string;
  description?: string;
  image_url_1x?: string;
  image_url_2x?: string;
  image_url_4x?: string;
};

type HelixBadgeSet = {
  set_id: string;
  versions: HelixBadgeVersion[];
};

/** set_id → version_id → version */
type BadgeIndex = Map<string, Map<string, HelixBadgeVersion>>;

interface BadgeCache {
  global: BadgeIndex;
  channels: Map<string, BadgeIndex>;
  globalFetchedAt: number;
}

const TTL_MS = 60 * 60 * 1000;
const cache: BadgeCache = {
  global: new Map(),
  channels: new Map(),
  globalFetchedAt: 0,
};

let appToken: { value: string; expiresAt: number } | null = null;

async function getAppAccessToken(): Promise<string> {
  if (appToken && appToken.expiresAt > Date.now() + 60_000) {
    return appToken.value;
  }
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    throw new Error(`Twitch app token failed: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  appToken = {
    value: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
  return appToken.value;
}

function indexSets(sets: HelixBadgeSet[]): BadgeIndex {
  const map: BadgeIndex = new Map();
  for (const set of sets) {
    const versions = new Map<string, HelixBadgeVersion>();
    for (const v of set.versions ?? []) {
      versions.set(v.id, v);
    }
    map.set(set.set_id, versions);
  }
  return map;
}

async function helixBadgeSets(url: string): Promise<BadgeIndex> {
  const token = await getAppAccessToken();
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Client-Id": env.TWITCH_CLIENT_ID,
    },
  });
  if (!res.ok) {
    console.error(`[twitch badges] ${url} → ${res.status} ${await res.text()}`);
    return new Map();
  }
  const body = (await res.json()) as { data?: HelixBadgeSet[] };
  return indexSets(body.data ?? []);
}

async function ensureGlobal(): Promise<BadgeIndex> {
  if (Date.now() - cache.globalFetchedAt < TTL_MS && cache.global.size) {
    return cache.global;
  }
  cache.global = await helixBadgeSets(
    "https://api.twitch.tv/helix/chat/badges/global",
  );
  cache.globalFetchedAt = Date.now();
  console.log(`[twitch badges] global sets=${cache.global.size}`);
  return cache.global;
}

async function ensureChannel(broadcasterId: string): Promise<BadgeIndex> {
  const hit = cache.channels.get(broadcasterId);
  if (hit) return hit;
  const sets = await helixBadgeSets(
    `https://api.twitch.tv/helix/chat/badges?broadcaster_id=${encodeURIComponent(broadcasterId)}`,
  );
  cache.channels.set(broadcasterId, sets);
  console.log(
    `[twitch badges] channel=${broadcasterId} sets=${sets.size}`,
  );
  return sets;
}

/** Normaliza tags.badges (objeto tmi) ou badges-raw ("broadcaster/1,subscriber/12") */
export function normalizeTwitchBadgeMap(
  badges: Record<string, string | undefined> | undefined | null,
  badgesRaw?: string | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (badges) {
    for (const [k, v] of Object.entries(badges)) {
      if (typeof v === "string" && v.length > 0) out[k] = v;
    }
  }
  if (badgesRaw && !Object.keys(out).length) {
    for (const part of badgesRaw.split(",")) {
      const [setId, version] = part.split("/");
      if (setId && version) out[setId] = version;
    }
  }
  return out;
}

/**
 * Resolve badges IRC → URLs Helix (global + canal).
 * Sempre devolve título; URL pode faltar se a versão não existir no set.
 */
export async function resolveTwitchBadges(
  badges: Record<string, string | undefined> | undefined | null,
  broadcasterId: string,
  badgesRaw?: string | null,
): Promise<ChatBadge[]> {
  const map = normalizeTwitchBadgeMap(badges, badgesRaw);
  const entries = Object.entries(map);
  if (!entries.length) return [];

  try {
    const global = await ensureGlobal();
    const channel = await ensureChannel(broadcasterId);
    const out: ChatBadge[] = [];
    for (const [setId, version] of entries) {
      const channelSet = channel.get(setId);
      const globalSet = global.get(setId);
      const ver =
        channelSet?.get(version) ??
        globalSet?.get(version) ??
        channelSet?.get("0") ??
        globalSet?.get("0") ??
        channelSet?.values().next().value ??
        globalSet?.values().next().value;
      out.push({
        id: `${setId}/${version}`,
        title: ver?.title ?? setId,
        url: ver?.image_url_2x ?? ver?.image_url_1x,
      });
    }
    return out;
  } catch (err) {
    console.error("[twitch badges] resolve failed", err);
    return entries.map(([setId, version]) => ({
      id: `${setId}/${version}`,
      title: setId,
    }));
  }
}
