// Intro, recap, credits and preview segments for skip buttons. Sources, best first:
// the file's own chapter names, TheIntroDB (matches the release length), IntroDB, PublicMetaDB,
// and AniSkip for anime. All times here are seconds.

import { getJson } from '../lib/http';
import { pmdb } from '../tracking/pmdb';

export type SegmentKind = 'intro' | 'recap' | 'credits' | 'preview';

export interface Segment {
  kind: SegmentKind;
  start: number;
  /** Null: runs to the end of the video. */
  end: number | null;
  source: string;
}

export interface SkipContext {
  imdbId?: string;
  tmdbId?: number;
  malId?: number;
  type: 'movie' | 'series';
  season?: number;
  episode?: number;
  /** Seconds; used to match the release and to sanity-check timestamps. */
  duration?: number;
  pmdbKey?: string | null;
}

const CHAPTER_KINDS: [RegExp, SegmentKind][] = [
  [/^(intro|opening|op|opening credits|title sequence|main titles?)\b/i, 'intro'],
  [/^(recap|previously( on)?|last time)\b/i, 'recap'],
  [/^(credits|ending|ed|end credits|closing credits|outro)\b/i, 'credits'],
  [/^(preview|next time|next episode)\b/i, 'preview'],
];

/** Segments from chapter titles, e.g. "Opening" from 0:52 to the next chapter. */
export function chapterSegments(chapters: { title?: string; time: number }[], duration: number): Segment[] {
  const out: Segment[] = [];
  chapters.forEach((c, i) => {
    const title = (c.title ?? '').trim();
    const kind = CHAPTER_KINDS.find(([re]) => re.test(title))?.[1];
    if (!kind) return;
    const end = chapters[i + 1]?.time ?? null;
    const length = (end ?? duration) - c.time;
    // A whole-episode "chapter" or a sliver is not a skippable segment.
    if (length < 5 || (duration > 0 && length > duration * 0.4 && kind !== 'credits')) return;
    out.push({ kind, start: c.time, end, source: 'chapters' });
  });
  return out;
}

interface TidbSegment {
  start_ms: number | null;
  end_ms: number | null;
}

async function theIntroDb(ctx: SkipContext): Promise<Segment[]> {
  if (!ctx.tmdbId && !ctx.imdbId) return [];
  const q = new URLSearchParams();
  if (ctx.tmdbId) q.set('tmdb_id', String(ctx.tmdbId));
  if (ctx.imdbId) q.set('imdb_id', ctx.imdbId);
  if (ctx.type === 'series') {
    q.set('season', String(ctx.season ?? 1));
    q.set('episode', String(ctx.episode ?? 1));
  }
  if (ctx.duration) q.set('duration_ms', String(Math.round(ctx.duration * 1000)));
  try {
    const res = await getJson<Partial<Record<SegmentKind, TidbSegment[]>>>(`https://api.theintrodb.org/v4/media?${q}`, { ttlMs: 6 * 3600 * 1000, timeoutMs: 8000, retries: 0 });
    const out: Segment[] = [];
    for (const kind of ['intro', 'recap', 'credits', 'preview'] as SegmentKind[]) {
      const first = res?.[kind]?.[0];
      if (!first) continue;
      out.push({ kind, start: (first.start_ms ?? 0) / 1000, end: first.end_ms === null ? null : first.end_ms / 1000, source: 'TheIntroDB' });
    }
    return out;
  } catch {
    return [];
  }
}

interface IntroDbSegment {
  start_ms: number;
  end_ms: number;
}

async function introDb(ctx: SkipContext): Promise<Segment[]> {
  if (!ctx.imdbId) return [];
  const q = new URLSearchParams({ imdb_id: ctx.imdbId });
  if (ctx.type === 'movie') q.set('is_movie', 'true');
  else {
    q.set('season', String(ctx.season ?? 1));
    q.set('episode', String(ctx.episode ?? 1));
  }
  try {
    const res = await getJson<{ intro?: IntroDbSegment | null; recap?: IntroDbSegment | null; outro?: IntroDbSegment | null }>(`https://api.introdb.app/segments?${q}`, { ttlMs: 6 * 3600 * 1000, timeoutMs: 8000, retries: 0 });
    const out: Segment[] = [];
    const add = (kind: SegmentKind, s?: IntroDbSegment | null) => s && out.push({ kind, start: s.start_ms / 1000, end: s.end_ms / 1000, source: 'IntroDB' });
    add('intro', res?.intro);
    add('recap', res?.recap);
    add('credits', res?.outro);
    return out;
  } catch {
    return [];
  }
}

async function publicMetaDb(ctx: SkipContext): Promise<Segment[]> {
  if (!ctx.tmdbId || !ctx.pmdbKey) return [];
  const rows = await pmdb.skips(ctx.pmdbKey, { tmdbId: ctx.tmdbId, mediaType: ctx.type === 'movie' ? 'movie' : 'tv', season: ctx.season, episode: ctx.episode });
  const r = rows.find((x) => x.source === 'streaming') ?? rows[0];
  if (!r) return [];
  const out: Segment[] = [];
  if (r.intro_end_ms) out.push({ kind: 'intro', start: (r.intro_start_ms ?? 0) / 1000, end: r.intro_end_ms / 1000, source: 'PublicMetaDB' });
  if (r.credits_start_ms) out.push({ kind: 'credits', start: r.credits_start_ms / 1000, end: r.credits_end_ms ? r.credits_end_ms / 1000 : null, source: 'PublicMetaDB' });
  return out;
}

async function aniSkip(ctx: SkipContext): Promise<Segment[]> {
  if (!ctx.malId || !ctx.episode) return [];
  const url = `https://api.aniskip.com/v2/skip-times/${ctx.malId}/${ctx.episode}?types=op&types=ed&types=recap&types=mixed-op&types=mixed-ed&episodeLength=${Math.round(ctx.duration ?? 0)}`;
  try {
    const res = await getJson<{ found?: boolean; results?: { interval: { startTime: number; endTime: number }; skipType: string }[] }>(url, { ttlMs: 6 * 3600 * 1000, timeoutMs: 8000, retries: 0 });
    if (!res?.found) return [];
    const map: Record<string, SegmentKind> = { op: 'intro', 'mixed-op': 'intro', ed: 'credits', 'mixed-ed': 'credits', recap: 'recap' };
    return (res.results ?? []).filter((r) => map[r.skipType]).map((r) => ({ kind: map[r.skipType], start: r.interval.startTime, end: r.interval.endTime, source: 'AniSkip' }));
  } catch {
    return [];
  }
}

/** Plausible for this video: inside it, positive length, not most of it. */
export function plausible(s: Segment, duration?: number): boolean {
  const end = s.end ?? duration ?? s.start + 1;
  if (!(end > s.start) || s.start < 0) return false;
  if (duration && duration > 0) {
    if (s.start > duration) return false;
    if (s.kind !== 'credits' && end - s.start > duration * 0.4) return false;
  }
  return true;
}

/** Per kind, the first plausible answer in source order. */
export function mergeSegments(groups: Segment[][], duration?: number): Segment[] {
  const out = new Map<SegmentKind, Segment>();
  for (const group of groups) for (const s of group) if (!out.has(s.kind) && plausible(s, duration)) out.set(s.kind, s);
  return [...out.values()].sort((a, b) => a.start - b.start);
}

export async function fetchSegments(ctx: SkipContext, chapters: Segment[]): Promise<Segment[]> {
  const [a, b, c, d] = await Promise.all([theIntroDb(ctx), introDb(ctx), publicMetaDb(ctx), aniSkip(ctx)]);
  return mergeSegments([chapters, a, b, c, d], ctx.duration);
}

export function activeSegment(segments: Segment[], t: number, duration: number): Segment | null {
  return segments.find((s) => t >= s.start && t < (s.end ?? duration) - 0.5) ?? null;
}
