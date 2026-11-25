// Continue Watching: resume points, plus the next episode of shows whose latest watched episode
// was finished. One card per title, newest activity first.

import { titleKey } from '../addons/ids';
import type { ProgressEntry, WatchedEntry, MediaType } from '../state/history';
import { byOrder, runningOrder, type EpisodeRef } from './episodes';

export type { EpisodeRef } from './episodes';

export interface ContinueItem {
  kind: 'resume' | 'next';
  key: string;
  metaId: string;
  type: MediaType;
  season?: number;
  episode?: number;
  videoId?: string;
  at: number;
  /** 0..1 for resume points. */
  progress?: number;
  positionS?: number;
  durationS?: number;
  /** The running time is a guess (see ProgressEntry.estimated). */
  estimated?: boolean;
  episodeTitle?: string;
  still?: string;
}

export interface ContinueInput {
  progress: Record<string, ProgressEntry>;
  watched: Record<string, WatchedEntry>;
  /** Title key (addons/ids titleKey) -> when the title was removed from Continue Watching. */
  dismissed: Record<string, number>;
  /** Episodes of each series, where known (from its metadata). */
  episodes: Map<string, EpisodeRef[] | null>;
  now?: number;
}

export interface ContinueResult {
  items: ContinueItem[];
  /** Series whose episode list is needed to work out what comes next. */
  needEpisodes: string[];
}

type Numbered = { season: number; episode: number };

const markKey = (e: Numbered) => `${e.season}:${e.episode}`;

/**
 * When an episode airs, as a time on this PC. Addons send a date, or midnight UTC standing for
 * one: that is a calendar day, not an instant, so it is read as that day here (west of UTC it
 * would otherwise land on the evening before). NaN when unknown.
 */
export function airTime(released: string | null | undefined): number {
  if (!released) return NaN;
  const day = airDay(released);
  return day ? new Date(day[0], day[1] - 1, day[2]).getTime() : Date.parse(released);
}

/** Whether `released` carries a real time of day (and not just a date). */
export function hasAirClock(released: string | null | undefined): boolean {
  return !!released && !airDay(released) && Number.isFinite(Date.parse(released));
}

function airDay(released: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)?)?$/.exec(released.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * The first aired episode after `after` that is not in `watched` (`season:episode`). Null while
 * the next one has not aired. Over the running order (library/episodes): specials and a season's
 * extras never come next.
 */
export function nextEpisode(episodes: EpisodeRef[], after: { season: number; episode: number }, watched: Set<string>, now: number): EpisodeRef | null {
  const list = runningOrder(episodes);
  for (const e of list) {
    if (byOrder(e, after) <= 0) continue;
    if (watched.has(markKey(e))) continue;
    const released = airTime(e.released);
    if (Number.isFinite(released) && released > now) return null;
    return e;
  }
  return null;
}

/** Where a viewer is in a show, from its watched marks. */
export interface SeriesPosition {
  /** The episode finished last. Marks made at the same moment (a whole season at once) go to the later episode. */
  latest: WatchedEntry & Numbered;
  /** `season:episode` -> when it was marked. */
  marks: Map<string, number>;
}

function addMark(pos: SeriesPosition | undefined, w: WatchedEntry): SeriesPosition | undefined {
  if (w.season === undefined || w.episode === undefined) return pos;
  const mark = w as WatchedEntry & Numbered;
  if (!pos) return { latest: mark, marks: new Map([[markKey(mark), w.at]]) };
  pos.marks.set(markKey(mark), w.at);
  if (w.at > pos.latest.at || (w.at === pos.latest.at && byOrder(mark, pos.latest) > 0)) pos.latest = mark;
  return pos;
}

/** The position in one show, given its watched entries. Null when no episode is marked. */
export function seriesPosition(entries: Iterable<WatchedEntry>): SeriesPosition | null {
  let pos: SeriesPosition | undefined;
  for (const w of entries) pos = addMark(pos, w);
  return pos ?? null;
}

/**
 * The episode to offer after the one finished last: the first aired one after it that has not
 * been watched. While a show is being watched again (the latest mark is a repeat), marks from
 * the earlier run do not count, so the next one in order is offered. The title page's Play
 * button and Continue Watching both use this.
 */
export function upNext(episodes: EpisodeRef[], pos: SeriesPosition, now: number): EpisodeRef | null {
  const again = (pos.latest.plays ?? 1) > 1;
  const list = runningOrder(episodes);
  for (const e of list) {
    if (byOrder(e, pos.latest) <= 0) continue;
    const mark = pos.marks.get(markKey(e));
    if (mark !== undefined && !(again && mark < pos.latest.at)) continue;
    const released = airTime(e.released);
    if (Number.isFinite(released) && released > now) return null;
    return e;
  }
  return null;
}

export function deriveContinue({ progress, watched, dismissed, episodes, now = Date.now() }: ContinueInput): ContinueResult {
  // One card per title. A `tmdb:` id is a different title as a movie and as a show.
  const best = new Map<string, ContinueItem>();
  // Only a recorded dismissal hides anything: entries with no timestamp (0) would otherwise
  // compare as dismissed forever.
  const hidden = (title: string, at: number) => {
    const d = dismissed[title];
    return d !== undefined && d >= at;
  };
  const offer = (item: ContinueItem) => {
    const title = titleKey(item.metaId, item.type);
    if (hidden(title, item.at)) return;
    const prev = best.get(title);
    if (!prev || item.at > prev.at) best.set(title, item);
  };

  for (const p of Object.values(progress)) {
    if (!(p.durationS > 0)) continue;
    offer({
      kind: 'resume',
      key: p.key,
      metaId: p.metaId,
      type: p.type,
      season: p.season,
      episode: p.episode,
      videoId: p.videoId,
      at: p.updatedAt,
      progress: Math.min(1, Math.max(0, p.positionS / p.durationS)),
      positionS: p.positionS,
      durationS: p.durationS,
      estimated: p.estimated,
      episodeTitle: p.episodeTitle,
      still: p.still,
    });
  }

  // Where each series stands: its latest finished episode and all its marks.
  const series = new Map<string, SeriesPosition>();
  for (const w of Object.values(watched)) {
    if (w.type !== 'series') continue;
    const pos = addMark(series.get(w.metaId), w);
    if (pos) series.set(w.metaId, pos);
  }

  const needEpisodes: string[] = [];
  for (const [metaId, pos] of series) {
    const w = pos.latest;
    const title = titleKey(metaId, 'series');
    const current = best.get(title);
    if (current && current.at >= w.at) continue; // a newer resume point wins
    if (hidden(title, w.at)) continue;
    const list = episodes.get(metaId);
    if (list === undefined) {
      needEpisodes.push(metaId);
      continue;
    }
    if (!list) continue;
    const next = upNext(list, pos, now);
    if (!next) {
      // Finished (or waiting on a new episode): a stale resume point from before should not linger.
      if (current && current.at < w.at) best.delete(title);
      continue;
    }
    offer({
      kind: 'next',
      key: `${metaId}:${next.season}:${next.episode}`,
      metaId,
      type: 'series',
      season: next.season,
      episode: next.episode,
      videoId: next.id,
      at: w.at,
      episodeTitle: next.title,
      still: next.thumbnail,
    });
  }

  const items = [...best.values()].sort((a, b) => b.at - a.at);
  // Most recent first, so the visible cards resolve first.
  needEpisodes.sort((a, b) => (series.get(b)?.latest.at ?? 0) - (series.get(a)?.latest.at ?? 0));
  return { items, needEpisodes };
}
