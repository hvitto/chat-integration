export type ChatPlatform = "twitch" | "youtube" | "kick";

export interface ChatBadge {
  id: string;
  title: string;
  url?: string;
}

export interface ChatEmoteSpan {
  id: string;
  start: number;
  end: number;
  name?: string;
  url: string;
  source: "twitch" | "kick" | "7tv" | "youtube";
}

export interface ChatFragment {
  type: "text" | "emote";
  text?: string;
  url?: string;
  name?: string;
}

export interface ChatStyleMeta {
  color?: string;
  badges?: ChatBadge[];
  emotes?: ChatEmoteSpan[];
  /** Cor/paint 7TV (hex ou CSS) — prioridade menor que color nativo se ambos existirem no client */
  sevenTvColor?: string;
  sevenTvPaintCss?: string;
}

export function twitchEmoteUrl(id: string): string {
  return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/1.0`;
}

export function kickEmoteUrl(id: string | number): string {
  return `https://files.kick.com/emotes/${id}/fullsize`;
}

export function sevenTvEmoteUrl(id: string): string {
  return `https://cdn.7tv.app/emote/${id}/1x.webp`;
}

/** Parseia emotes do IRC Twitch (string raw ou objeto do tmi.js) */
export function parseTwitchEmotes(
  emotesTag: string | Record<string, string[]> | undefined | null,
  message: string,
): ChatEmoteSpan[] {
  if (!emotesTag || !message) return [];
  const spans: ChatEmoteSpan[] = [];

  if (typeof emotesTag === "string") {
    for (const part of emotesTag.split("/")) {
      if (!part) continue;
      const [id, ranges] = part.split(":");
      if (!id || !ranges) continue;
      for (const range of ranges.split(",")) {
        const [a, b] = range.split("-").map(Number);
        if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) continue;
        spans.push({
          id,
          start: a,
          end: b,
          name: message.slice(a, b + 1),
          url: twitchEmoteUrl(id),
          source: "twitch",
        });
      }
    }
  } else {
    for (const [id, ranges] of Object.entries(emotesTag)) {
      for (const range of ranges ?? []) {
        const [a, b] = range.split("-").map(Number);
        if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) continue;
        spans.push({
          id,
          start: a,
          end: b,
          name: message.slice(a, b + 1),
          url: twitchEmoteUrl(id),
          source: "twitch",
        });
      }
    }
  }
  return spans.sort((x, y) => x.start - y.start);
}

/**
 * Kick embute emotes no texto: [emote:37226:KEKW]
 * Retorna spans no texto original + texto “limpo” com o nome do emote no lugar.
 */
export function parseKickEmotesInContent(content: string): {
  plain: string;
  emotes: ChatEmoteSpan[];
} {
  const re = /\[emote:(\d+):([^\]]+)\]/g;
  const emotes: ChatEmoteSpan[] = [];
  let plain = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    plain += content.slice(last, match.index);
    const id = match[1];
    const name = match[2];
    const start = plain.length;
    plain += name;
    const end = plain.length - 1;
    emotes.push({
      id,
      start,
      end,
      name,
      url: kickEmoteUrl(id),
      source: "kick",
    });
    last = match.index + match[0].length;
  }
  plain += content.slice(last);
  return { plain, emotes };
}

export function mergeEmoteSpans(
  base: ChatEmoteSpan[],
  extra: ChatEmoteSpan[],
): ChatEmoteSpan[] {
  if (!extra.length) return base;
  const occupied = (s: ChatEmoteSpan, t: ChatEmoteSpan) =>
    !(t.end < s.start || t.start > s.end);
  const out = [...base];
  for (const e of extra) {
    if (out.some((b) => occupied(b, e))) continue;
    out.push(e);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Encaixa emotes 7TV por nome (token) em trechos sem emote nativo. */
export function matchNamedEmotes(
  message: string,
  catalog: Map<string, { id: string; url: string; source: ChatEmoteSpan["source"] }>,
  existing: ChatEmoteSpan[] = [],
): ChatEmoteSpan[] {
  if (!catalog.size || !message) return existing;
  const blocked = new Set<number>();
  for (const e of existing) {
    for (let i = e.start; i <= e.end; i++) blocked.add(i);
  }
  const found: ChatEmoteSpan[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    const start = m.index;
    const end = start + m[0].length - 1;
    let overlap = false;
    for (let i = start; i <= end; i++) {
      if (blocked.has(i)) {
        overlap = true;
        break;
      }
    }
    if (overlap) continue;
    const hit = catalog.get(m[0]);
    if (!hit) continue;
    found.push({
      id: hit.id,
      start,
      end,
      name: m[0],
      url: hit.url,
      source: hit.source,
    });
    for (let i = start; i <= end; i++) blocked.add(i);
  }
  return mergeEmoteSpans(existing, found);
}

export function buildFragments(
  message: string,
  emotes: ChatEmoteSpan[] = [],
): ChatFragment[] {
  if (!emotes.length) return [{ type: "text", text: message }];
  const sorted = [...emotes].sort((a, b) => a.start - b.start);
  const fragments: ChatFragment[] = [];
  let cursor = 0;
  for (const e of sorted) {
    if (e.start > cursor) {
      fragments.push({ type: "text", text: message.slice(cursor, e.start) });
    }
    if (e.start >= cursor) {
      fragments.push({
        type: "emote",
        url: e.url,
        name: e.name ?? message.slice(e.start, e.end + 1),
      });
      cursor = e.end + 1;
    }
  }
  if (cursor < message.length) {
    fragments.push({ type: "text", text: message.slice(cursor) });
  }
  return fragments;
}

export function intColorToHex(color: number | undefined | null): string | undefined {
  if (color == null || !Number.isFinite(color)) return undefined;
  const n = color < 0 ? color >>> 0 : color;
  return `#${(n & 0xffffff).toString(16).padStart(6, "0")}`;
}
