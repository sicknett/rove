// Continue Watching: resume points, plus the next episode of shows whose latest watched episode
// was finished. One card per title, newest activity first.

import type { ProgressEntry, WatchedEntry, MediaType } from '../state/history';

export interface EpisodeRef {
  id: string;
  season: number;
  episode: number;
  released?: string;
  title?: string;
  thumbnail?: string;
}

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

const byOrder = (a: { season: number; episode: number }, b: { season: number; episode: number }) => a.season - b.season || a.episode - b.episode;

export function nextEpisode(episodes: EpisodeRef[], after: { season: number; episode: number }, watched: Set<string>, now: number): EpisodeRef | null {
  const list = episodes.filter((e) => e.season > 0).sort(byOrder);
  for (const e of list) {
    if (byOrder(e, after) <= 0) continue;
    if (watched.has(`${e.season}:${e.episode}`)) continue;
    const released = e.released ? Date.parse(e.released) : NaN;
    if (Number.isFinite(released) && released > now) return null;
    return e;
  }
  return null;
}

export function deriveContinue({ progress, watched, dismissed, episodes, now = Date.now() }: ContinueInput): ContinueResult {
  const best = new Map<string, ContinueItem>();
  const offer = (item: ContinueItem) => {
    if ((dismissed[item.metaId] ?? 0) >= item.at) return;
    const prev = best.get(item.metaId);
    if (!prev || item.at > prev.at) best.set(item.metaId, item);
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

  // The latest finished episode of each series.
  const latest = new Map<string, WatchedEntry>();
  const watchedBySeries = new Map<string, Set<string>>();
  for (const w of Object.values(watched)) {
    if (w.type !== 'series' || w.season === undefined || w.episode === undefined) continue;
    let set = watchedBySeries.get(w.metaId);
    if (!set) watchedBySeries.set(w.metaId, (set = new Set()));
    set.add(`${w.season}:${w.episode}`);
    const prev = latest.get(w.metaId);
    if (!prev || w.at > prev.at || (w.at === prev.at && byOrder(w as { season: number; episode: number }, prev as { season: number; episode: number }) > 0)) latest.set(w.metaId, w);
  }

  const needEpisodes: string[] = [];
  for (const [metaId, w] of latest) {
    const current = best.get(metaId);
    if (current && current.at >= w.at) continue; // a newer resume point wins
    if ((dismissed[metaId] ?? 0) >= w.at) continue;
    const list = episodes.get(metaId);
    if (list === undefined) {
      needEpisodes.push(metaId);
      continue;
    }
    if (!list) continue;
    const next = nextEpisode(list, { season: w.season!, episode: w.episode! }, watchedBySeries.get(metaId) ?? new Set(), now);
    if (!next) {
      // Finished (or waiting on a new episode): a stale resume point from before should not linger.
      if (current && current.at < w.at) best.delete(metaId);
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
  needEpisodes.sort((a, b) => (latest.get(b)?.at ?? 0) - (latest.get(a)?.at ?? 0));
  return { items, needEpisodes };
}
