// "Play" from anywhere: works out which video (for a show: the episode in progress, else the next
// unwatched, else the first) and hands it to the playback session. Every target is built under
// the title's history id (IMDb when it maps), whatever id the card that was clicked carries.

import { addonsFor, fetchMeta } from '../addons/client';
import { episodeId, parseId, tmdbTitleNumber, watchKey } from '../addons/ids';
import type { Meta, Video } from '../addons/types';
import { episodeGuide, episodesOf } from '../data/hooks';
import { seriesPosition, upNext, type EpisodeRef } from '../library/continue';
import { serversFor } from '../servers';
import { useHistory, type MediaType, type ProgressEntry } from '../state/history';
import { alternateId, canonicalId, canonicalNow, tmdbFor } from '../tracking/idmap';
import { toast } from '../ui/toast';
import { play, usePlayback, type PlayOptions, type PlayTarget } from './session';
import type { CardTitle } from '../media/actions';

/** How long a launch waits for an id lookup before going on without it (the lookup carries on). */
const ID_WAIT_MS = 4000;
/** A launch that is ready sooner than this shows no "finding" of its own (it would only flash by). */
const FINDING_AFTER_MS = 120;

/** `promise`, or `fallback` when it takes longer than `ms` or fails. */
function soon<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise.catch(() => fallback), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

const takers = (type: MediaType, videoId: string) => addonsFor('stream', type === 'movie' ? 'movie' : 'series', videoId).length + serversFor(videoId).length;

/**
 * A video id the user's stream addons accept. Most take IMDb ids, some only `tmdb:` ones: when
 * nothing takes the id as it is, the same video under the other family is used if that has takers.
 */
export async function streamableVideoId(type: MediaType, videoId: string): Promise<string> {
  if (videoId.startsWith('srv:') || takers(type, videoId) > 0) return videoId;
  // No stream addon of any kind and no media server: no other id would find takers either.
  if (addonsFor('stream', type === 'movie' ? 'movie' : 'series').length + serversFor('tt0').length === 0) return videoId;
  const other = await soon(alternateId(videoId, type), ID_WAIT_MS, null);
  return other && takers(type, other) > 0 ? other : videoId;
}

function videoFor(meta: Meta | null | undefined, ep: EpisodeRef): Video | undefined {
  return meta?.videos?.find((v) => v.id === ep.id);
}

/**
 * The saved position Play would resume from, by the rule the session applies when it starts
 * (session.ts savedPosition): none within the last minute of the video, or when a tracker's
 * estimate sits at either end. Labels use this, so "Resume" is only shown when it will resume.
 */
export function resumePoint(progress: Record<string, ProgressEntry>, metaId: string, season?: number, episode?: number): ProgressEntry | null {
  const p = progress[watchKey(metaId, season, episode)];
  if (!p || !(p.durationS > 0)) return null;
  const share = p.positionS / p.durationS;
  if (p.estimated) return share > 0.01 && share < 0.97 ? p : null;
  return p.durationS - p.positionS < 60 ? null : p;
}

/** The episode a series "Play" should start. */
export function pickEpisode(meta: Meta, metaId: string): { ep: EpisodeRef; resume: boolean } | null {
  // The running order (library/episodes): specials and a season's extras are never what Play starts.
  const eps = episodeGuide(meta).main;
  if (!eps.length) return null;
  const id = canonicalNow(metaId, 'series');
  const h = useHistory.getState();
  // An episode in progress, most recent first.
  const inProgress = Object.values(h.progress)
    .filter((p) => p.metaId === id && p.type === 'series')
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  // Continue Watching works from the same position, so both offer the same episode.
  const pos = seriesPosition(Object.values(h.watched).filter((w) => w.metaId === id && w.type === 'series'));
  if (inProgress && (!pos || inProgress.updatedAt >= pos.latest.at)) {
    const ep = eps.find((e) => e.season === inProgress.season && e.episode === inProgress.episode);
    if (ep) return { ep, resume: true };
  }
  if (pos) {
    const next = upNext(eps, pos, Date.now());
    if (next) return { ep: next, resume: false };
  }
  return { ep: eps[0], resume: false };
}

export async function episodeTarget(meta: Meta | null, metaId: string, ep: EpisodeRef, card?: Partial<CardTitle>): Promise<PlayTarget> {
  const id = canonicalNow(metaId, 'series');
  const v = videoFor(meta, ep);
  const ids = await soon(tmdbFor(id, 'series'), ID_WAIT_MS, null);
  return {
    type: 'series',
    metaId: id,
    videoId: await streamableVideoId('series', ep.id || episodeId(id, ep.season, ep.episode)),
    season: ep.season,
    episode: ep.episode,
    name: meta?.name ?? card?.name ?? '',
    episodeTitle: ep.title ?? v?.title,
    poster: meta?.poster ?? card?.poster,
    background: meta?.background ?? card?.background,
    logo: meta?.logo ?? card?.logo,
    still: ep.thumbnail,
    tmdbId: ids?.id ?? tmdbTitleNumber(metaId) ?? undefined,
  };
}

export async function movieTarget(meta: Meta | null, metaId: string, card?: Partial<CardTitle>): Promise<PlayTarget> {
  const id = canonicalNow(metaId, 'movie');
  const ids = await soon(tmdbFor(id, 'movie'), ID_WAIT_MS, null);
  return {
    type: 'movie',
    metaId: id,
    videoId: await streamableVideoId('movie', meta?.behaviorHints?.defaultVideoId ?? id),
    name: meta?.name ?? card?.name ?? '',
    poster: meta?.poster ?? card?.poster,
    background: meta?.background ?? card?.background,
    logo: meta?.logo ?? card?.logo,
    tmdbId: ids?.id ?? tmdbTitleNumber(metaId) ?? undefined,
  };
}

interface Launch {
  key: string;
  /** What "finding" shows while this launch is prepared; also how the launch knows it is still wanted. */
  holder: PlayTarget;
}

/** The launch being prepared (metadata and ids on their way), until the session takes over. */
let launch: Launch | null = null;

/**
 * Prepares a play target and hands it to the session.
 * - "Finding" shows from the card almost at once (the session's own `finding` state), so a click
 *   is answered while metadata and ids are still on their way.
 * - A second click on the same thing while it is being prepared does nothing; a click on
 *   something else takes over; Cancel on the overlay, or leaving the player, stops it.
 * - Whatever fails ends in a message, never in a button that silently did nothing.
 */
async function prepare(key: string, about: Omit<PlayTarget, 'videoId' | 'name'> & { name?: string }, build: () => Promise<{ target: PlayTarget; opts: PlayOptions } | string>): Promise<void> {
  if (launch?.key === key) return;
  // `pending:` is no video id: the player compares this with the video it is showing.
  const mine: Launch = { key, holder: { ...about, name: about.name ?? '', videoId: `pending:${key}` } };
  launch = mine;
  const from = usePlayback.getState().session?.id;
  let shown = false;
  const show = setTimeout(() => {
    if (launch !== mine) return;
    shown = true;
    usePlayback.setState({ finding: mine.holder });
  }, FINDING_AFTER_MS);
  // Still wanted: nothing else was started, "finding" was not cancelled, and what was playing
  // when it began (if anything) has not been stopped or replaced.
  const wanted = () => launch === mine && (!shown || usePlayback.getState().finding === mine.holder) && usePlayback.getState().session?.id === from;
  try {
    const ready = await build();
    if (!wanted()) return;
    // From here the session shows its own state (finding, the source list, or the resume question).
    launch = null;
    clearTimeout(show);
    if (shown) usePlayback.setState({ finding: null });
    if (typeof ready === 'string') toast.error(ready);
    else await play(ready.target, ready.opts);
  } catch (e) {
    console.error(e);
    toast.error('Could not start playback.');
  } finally {
    clearTimeout(show);
    if (launch === mine) launch = null;
    if (usePlayback.getState().finding === mine.holder) usePlayback.setState({ finding: null });
  }
}

/** Play a title from a card or the hero. */
export function playTitle(type: MediaType, metaId: string, card?: Partial<CardTitle>, opts: { choose?: boolean; fromStart?: boolean } = {}): Promise<void> {
  const about = { type, metaId, poster: card?.poster, background: card?.background, logo: card?.logo, name: card?.name };
  return prepare(`${type}:${metaId}:${opts.choose ? 'choose' : 'play'}`, about, async () => {
    const id = await canonicalId(metaId, type, { timeoutMs: ID_WAIT_MS });
    let unanswered = false;
    const meta = await fetchMeta(type === 'movie' ? 'movie' : 'series', id).catch((e) => {
      console.warn('metadata did not arrive', e);
      unanswered = true;
      return null;
    });
    // A movie plays without metadata: its id is all the stream addons need.
    if (type === 'movie') return { target: await movieTarget(meta, id, card), opts: { meta, ...opts } };
    const pick = meta ? pickEpisode(meta, id) : null;
    if (pick) return { target: await episodeTarget(meta, id, pick.ep, card), opts: { meta, ...opts } };
    // No episode list, but an episode in progress says where to go on.
    const inProgress = Object.values(useHistory.getState().progress)
      .filter((p) => p.metaId === id && p.type === 'series' && p.season !== undefined && p.episode !== undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (inProgress) {
      const ep = { id: inProgress.videoId ?? episodeId(id, inProgress.season!, inProgress.episode!), season: inProgress.season!, episode: inProgress.episode!, title: inProgress.episodeTitle };
      return { target: await episodeTarget(meta, id, ep, card), opts: { meta, ...opts } };
    }
    if (meta) return 'This show has no episodes listed yet.';
    return unanswered ? 'Your metadata addons did not answer, so the episodes of this show are unknown. Try again in a moment.' : 'No metadata addon knows this show, so its episodes are unknown.';
  });
}

/** Play a movie whose metadata is at hand (the title page). */
export function playMovie(meta: Meta | null, metaId: string, card?: Partial<CardTitle>, opts: { choose?: boolean; fromStart?: boolean } = {}): Promise<void> {
  const about = { type: 'movie' as const, metaId, poster: meta?.poster ?? card?.poster, background: meta?.background ?? card?.background, logo: meta?.logo ?? card?.logo, name: meta?.name ?? card?.name };
  return prepare(`movie:${metaId}:${opts.choose ? 'choose' : 'play'}`, about, async () => ({ target: await movieTarget(meta, metaId, card), opts: { meta, ...opts } }));
}

/** Play a specific episode (title page, Continue Watching, the player's episode list). */
export function playEpisode(meta: Meta | null, metaId: string, ep: EpisodeRef, opts: { choose?: boolean; fromStart?: boolean; unattended?: number } = {}, card?: Partial<CardTitle>): Promise<void> {
  const about = { type: 'series' as const, metaId, season: ep.season, episode: ep.episode, episodeTitle: ep.title, poster: meta?.poster ?? card?.poster, background: meta?.background ?? card?.background, logo: meta?.logo ?? card?.logo, name: meta?.name ?? card?.name };
  return prepare(`series:${metaId}:${ep.season}:${ep.episode}:${opts.choose ? 'choose' : 'play'}`, about, async () => ({ target: await episodeTarget(meta, metaId, ep, card), opts: { meta, ...opts } }));
}

/** Continue Watching card. */
export function playContinue(item: { metaId: string; type: MediaType; season?: number; episode?: number; videoId?: string; episodeTitle?: string; name?: string; poster?: string; background?: string; logo?: string }): Promise<void> {
  if (item.type === 'movie') return playTitle('movie', item.metaId, item);
  const { season, episode } = item;
  if (season === undefined || episode === undefined) return playTitle('series', item.metaId, item);
  const about = { type: 'series' as const, metaId: item.metaId, season, episode, episodeTitle: item.episodeTitle, poster: item.poster, background: item.background, logo: item.logo, name: item.name };
  return prepare(`series:${item.metaId}:${season}:${episode}:play`, about, async () => {
    const id = canonicalNow(item.metaId, 'series');
    const meta = await fetchMeta('series', id).catch((e) => {
      console.warn('metadata did not arrive', e);
      return null;
    });
    // The card says which episode: it plays even when the metadata is missing or does not list it.
    const listed = meta ? episodesOf(meta).find((e) => e.season === season && e.episode === episode) : undefined;
    const ep = listed ?? { id: item.videoId && parseId(item.videoId).season === season ? item.videoId : episodeId(id, season, episode), season, episode, title: item.episodeTitle };
    return { target: await episodeTarget(meta, id, ep, item), opts: { meta } };
  });
}

export function hasResume(metaId: string, season?: number, episode?: number) {
  return !!resumePoint(useHistory.getState().progress, metaId, season, episode);
}
