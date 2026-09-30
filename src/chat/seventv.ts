import {
  intColorToHex,
  matchNamedEmotes,
  sevenTvEmoteUrl,
  type ChatEmoteSpan,
} from "./meta.js";

interface SevenTvEmote {
  id: string;
  name: string;
}

interface ChannelPack {
  emotes: Map<string, { id: string; url: string }>;
  fetchedAt: number;
}

interface UserStyle {
  color?: string;
  paintCss?: string;
  fetchedAt: number;
}

const TTL_MS = 30 * 60 * 1000;
const channelCache = new Map<string, ChannelPack>();
const userStyleCache = new Map<string, UserStyle>();
let globalEmotes: Map<string, { id: string; url: string }> = new Map();
let globalFetchedAt = 0;

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function emotesFromSet(set: {
  emotes?: Array<{ id: string; name: string }>;
} | null): Map<string, { id: string; url: string }> {
  const map = new Map<string, { id: string; url: string }>();
  for (const e of set?.emotes ?? []) {
    if (!e?.id || !e?.name) continue;
    map.set(e.name, { id: e.id, url: sevenTvEmoteUrl(e.id) });
  }
  return map;
}

async function ensureGlobal(): Promise<Map<string, { id: string; url: string }>> {
  if (Date.now() - globalFetchedAt < TTL_MS && globalEmotes.size) {
    return globalEmotes;
  }
  const data = await fetchJson<{ emotes?: SevenTvEmote[] }>(
    "https://7tv.io/v3/emote-sets/global",
  );
  globalEmotes = emotesFromSet(data);
  globalFetchedAt = Date.now();
  return globalEmotes;
}

export async function getSevenTvCatalogForChannel(
  twitchUserId: string,
): Promise<Map<string, { id: string; url: string; source: "7tv" }>> {
  const global = await ensureGlobal();
  let pack = channelCache.get(twitchUserId);
  if (!pack || Date.now() - pack.fetchedAt >= TTL_MS) {
    const user = await fetchJson<{
      emote_set?: { emotes?: SevenTvEmote[] };
    }>(`https://7tv.io/v3/users/twitch/${twitchUserId}`);
    pack = {
      emotes: emotesFromSet(user?.emote_set ?? null),
      fetchedAt: Date.now(),
    };
    channelCache.set(twitchUserId, pack);
  }
  const catalog = new Map<string, { id: string; url: string; source: "7tv" }>();
  for (const [name, e] of global) {
    catalog.set(name, { ...e, source: "7tv" });
  }
  for (const [name, e] of pack.emotes) {
    catalog.set(name, { ...e, source: "7tv" });
  }
  return catalog;
}

async function resolvePaintCss(paintId: string | undefined): Promise<string | undefined> {
  if (!paintId) return undefined;
  const paint = await fetchJson<{
    stops?: Array<{ color: number; at: number }>;
    function?: string;
    angle?: number;
    image_url?: string;
  }>(`https://7tv.io/v3/paints/${paintId}`);
  if (!paint) return undefined;
  if (paint.image_url) {
    return `url(${paint.image_url})`;
  }
  const stops = paint.stops ?? [];
  if (stops.length >= 2) {
    const parts = stops
      .map((s) => `${intColorToHex(s.color) ?? "#fff"} ${Math.round(s.at * 100)}%`)
      .join(", ");
    const angle = paint.angle ?? 90;
    return `linear-gradient(${angle}deg, ${parts})`;
  }
  if (stops[0]) return intColorToHex(stops[0].color);
  return undefined;
}

export async function getSevenTvUserStyle(twitchUserId: string): Promise<{
  color?: string;
  paintCss?: string;
}> {
  const hit = userStyleCache.get(twitchUserId);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) {
    return { color: hit.color, paintCss: hit.paintCss };
  }
  const user = await fetchJson<{
    style?: { color?: number; paint_id?: string };
  }>(`https://7tv.io/v3/users/twitch/${twitchUserId}`);
  const color = intColorToHex(user?.style?.color);
  const paintCss = await resolvePaintCss(user?.style?.paint_id);
  const style: UserStyle = { color, paintCss, fetchedAt: Date.now() };
  userStyleCache.set(twitchUserId, style);
  return { color: style.color, paintCss: style.paintCss };
}

export async function enrichWithSevenTv(params: {
  streamerTwitchUserId: string;
  /** Preferir estilo 7TV do user Twitch (mensagens linked / origem Twitch) */
  styleTwitchUserId?: string;
  message: string;
  emotes: ChatEmoteSpan[];
}): Promise<{
  emotes: ChatEmoteSpan[];
  sevenTvColor?: string;
  sevenTvPaintCss?: string;
}> {
  const catalog = await getSevenTvCatalogForChannel(params.streamerTwitchUserId);
  const merged = matchNamedEmotes(params.message, catalog, params.emotes);

  let sevenTvColor: string | undefined;
  let sevenTvPaintCss: string | undefined;
  if (params.styleTwitchUserId) {
    const style = await getSevenTvUserStyle(params.styleTwitchUserId);
    sevenTvColor = style.color;
    sevenTvPaintCss = style.paintCss;
  }

  return { emotes: merged, sevenTvColor, sevenTvPaintCss };
}
