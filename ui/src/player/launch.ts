// "Play" from anywhere: works out which video (for a show: the episode in progress, else the next
// unwatched, else the first) and hands it to the playback session.

import { addonsFor, fetchMeta } from '../addons/client';
import { episodeId, parseId, watchKey } from '../addons/ids';
import type { Meta, Video } from '../addons/types';
import { episodesOf } from '../data/hooks';
import { nextEpisode, type EpisodeRef } from '../library/continue';
import { useHistory, type MediaType } from '../state/history';
import { tmdbFor, metaIdFor } from '../tracking/idmap';
import { useTracker } from '../tracking/sync';
import { toast } from '../ui/toast';
import { play, type PlayTarget } from './session';
import type { CardTitle } from '../media/actions';

/**
 * A video id the user's stream addons accept. `tmdb:` ids become IMDb ids when no stream addon
 * takes `tmdb:` (most expect IMDb).
 */
export async function streamableVideoId(type: MediaType, videoId: string): Promise<string> {
  const t = type === 'movie' ? 'movie' : 'series';
  if (addonsFor('stream', t, videoId).length > 0) return videoId;
  const p = parseId(videoId);
  if (!/^tmdb:/i.test(p.base)) return videoId;
  const imdb = await metaIdFor(Number(p.base.split(':')[1]), type === 'movie' ? 'movie' : 'tv', useTracker.getState().apiKey);
  if (!/^tt\d+$/.test(imdb)) return videoId;
  return p.season !== undefined && p.episode !== undefined ? episodeId(imdb, p.season, p.episode) : imdb;
}

function videoFor(meta: Meta | null | undefined, ep: EpisodeRef): Video | undefined {
  return meta?.videos?.find((v) => v.id === ep.id);
}

/** The episode a series "Play" should start. */
export function pickEpisode(meta: Meta, metaId: string): { ep: EpisodeRef; resume: boolean } | null {
  const eps = episodesOf(meta).filter((e) => e.season > 0);
  if (!eps.length) return null;
  const h = useHistory.getState();
  // An episode in progress, most recent first.
  const inProgress = Object.values(h.progress)
    .filter((p) => p.metaId === metaId && p.type === 'series')
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const latestWatched = Object.values(h.watched)
    .filter((w) => w.metaId === metaId && w.season !== undefined && w.episode !== undefined)
    .sort((a, b) => b.at - a.at)[0];
  if (inProgress && (!latestWatched || inProgress.updatedAt >= latestWatched.at)) {
    const ep = eps.find((e) => e.season === inProgress.season && e.episode === inProgress.episode);
    if (ep) return { ep, resume: true };
  }
  if (latestWatched) {
    const watchedSet = new Set(Object.values(h.watched).filter((w) => w.metaId === metaId).map((w) => `${w.season}:${w.episode}`));
    const next = nextEpisode(eps, { season: latestWatched.season!, episode: latestWatched.episode! }, watchedSet, Date.now());
    if (next) return { ep: next, resume: false };
  }
  return { ep: [...eps].sort((a, b) => a.season - b.season || a.episode - b.episode)[0], resume: false };
}

export async function episodeTarget(meta: Meta, metaId: string, ep: EpisodeRef, card?: Partial<CardTitle>): Promise<PlayTarget> {
  const v = videoFor(meta, ep);
  const ids = await tmdbFor(metaId, 'series', useTracker.getState().apiKey).catch(() => null);
  return {
    type: 'series',
    metaId,
    videoId: await streamableVideoId('series', ep.id || episodeId(metaId, ep.season, ep.episode)),
    season: ep.season,
    episode: ep.episode,
    name: meta.name ?? card?.name ?? '',
    episodeTitle: ep.title ?? v?.title,
    poster: meta.poster ?? card?.poster,
    background: meta.background ?? card?.background,
    logo: meta.logo ?? card?.logo,
    still: ep.thumbnail,
    tmdbId: ids?.id,
  };
}

export async function movieTarget(meta: Meta | null, metaId: string, card?: Partial<CardTitle>): Promise<PlayTarget> {
  const ids = await tmdbFor(metaId, 'movie', useTracker.getState().apiKey).catch(() => null);
  return {
    type: 'movie',
    metaId,
    videoId: await streamableVideoId('movie', meta?.behaviorHints?.defaultVideoId ?? metaId),
    name: meta?.name ?? card?.name ?? '',
    poster: meta?.poster ?? card?.poster,
    background: meta?.background ?? card?.background,
    logo: meta?.logo ?? card?.logo,
    tmdbId: ids?.id,
  };
}

/** Play a title from a card or the hero. */
export async function playTitle(type: MediaType, metaId: string, card?: Partial<CardTitle>, opts: { choose?: boolean } = {}) {
  try {
    const meta = await fetchMeta(type === 'movie' ? 'movie' : 'series', metaId);
    if (type === 'movie') {
      await play(await movieTarget(meta, metaId, card), { meta, choose: opts.choose });
      return;
    }
    if (!meta) {
      toast.error('No metadata addon knows this show, so its episodes are unknown.');
      return;
    }
    const pick = pickEpisode(meta, metaId);
    if (!pick) {
      toast.error('This show has no episodes listed yet.');
      return;
    }
    await play(await episodeTarget(meta, metaId, pick.ep, card), { meta, choose: opts.choose });
  } catch (e) {
    console.error(e);
    toast.error('Could not start playback.');
  }
}

/** Play a specific episode (title page, Continue Watching, the player's episode list). */
export async function playEpisode(meta: Meta, metaId: string, ep: EpisodeRef, opts: { choose?: boolean; fromStart?: boolean; unattended?: number } = {}) {
  await play(await episodeTarget(meta, metaId, ep), { meta, ...opts });
}

/** Continue Watching card. */
export async function playContinue(item: { metaId: string; type: MediaType; season?: number; episode?: number; videoId?: string; name?: string; poster?: string; background?: string; logo?: string }) {
  if (item.type === 'movie') return playTitle('movie', item.metaId, item);
  const meta = await fetchMeta('series', item.metaId);
  if (!meta) return playTitle('series', item.metaId, item);
  const ep = episodesOf(meta).find((e) => e.season === item.season && e.episode === item.episode);
  if (!ep) return playTitle('series', item.metaId, item);
  await playEpisode(meta, item.metaId, ep);
}

export function hasResume(metaId: string, season?: number, episode?: number) {
  return !!useHistory.getState().progress[watchKey(metaId, season, episode)];
}
