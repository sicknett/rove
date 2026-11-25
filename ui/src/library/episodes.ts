// A show's episode guide, from the `videos` its metadata addon sends. Everything that walks a
// show's episodes (the title page, the player's episode panel, "next episode", Play, "mark
// season watched", Calendar, Continue Watching) reads the guide built here, so they all agree on
// what is an episode, what is an extra, and what comes next.
//
// The rule:
//  1. Season and episode come from the video's own `season` and `episode` fields (`number` when
//     there is no `episode`); the numbers in its id (`tt…:1:2`) stand in for a field that is
//     missing. A video with an episode number and no season at all is season 1. A video with no
//     episode number anywhere is listed with the Specials, after the numbered ones.
//  2. A video listed twice is one entry: the same id again, or the same season and episode again
//     under the same name. Two different videos that claim one number both stay: the first is
//     the episode, the other an extra of that season.
//  3. Season 0 is Specials. It comes after the numbered seasons and is never part of the running
//     order.
//  4. Inside a numbered season, extras the data files there (behind-the-scenes clips and the
//     like) are told from episodes by where they sit: numbered far past the season's run, and
//     also dated outside the season, or much shorter than its episodes, or without the stills
//     the episodes have, or named like extras. They stay in that season, in their own group
//     after its episodes, and are never part of the running order.

import { parseId } from '../addons/ids';
import type { Video } from '../addons/types';

export interface EpisodeRef {
  id: string;
  season: number;
  episode: number;
  released?: string;
  title?: string;
  thumbnail?: string;
  /** Minutes. */
  runtime?: number;
  overview?: string;
  /** Filed in a numbered season by the data, but not one of its episodes (see the rule above). */
  extra?: boolean;
  /** Unique within its show's guide: what a list of episodes is keyed by. */
  key?: string;
}

export interface SeasonGroup {
  /** 0 is Specials. */
  season: number;
  /** In order. For Specials: every special. */
  episodes: EpisodeRef[];
  /** Extras the data files in this season, in order. Empty for Specials. */
  extras: EpisodeRef[];
}

export interface EpisodeGuide {
  /** One group per season: numbered seasons ascending, Specials last. */
  seasons: SeasonGroup[];
  /** The running order: the episodes of the numbered seasons, without extras or specials. */
  main: EpisodeRef[];
  /** Every video once: each numbered season's episodes then its extras, then Specials. */
  all: EpisodeRef[];
}

const DAY = 24 * 3600 * 1000;
/** A jump in numbering wider than this (and than the run before it) ends a season's run. */
const RUN_BREAK = 10;
/** An extra is dated at least this long before its season starts… */
const BEFORE_SEASON_MS = 30 * DAY;
/** …or, when no later season says where this one ends, this long after its last episode. */
const AFTER_SEASON_MS = 180 * DAY;

const EXTRA_NAMES =
  /\b(behind the (scenes|story)|making[- ]of|the making of|deleted scenes?|featurette|bloopers?|gag reel|outtakes?|interviews?|recap|trailer|teaser|sneak peek|first look|inside look|after ?show)\b/i;

const EMPTY: EpisodeGuide = { seasons: [], main: [], all: [] };

type Numbered = { season: number; episode: number };

export const byOrder = (a: Numbered, b: Numbered) => a.season - b.season || a.episode - b.episode;

/** A whole or fractional number from a field that may hold a number or its text. */
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : undefined;
  if (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return undefined;
}

function minutes(v: unknown): number | undefined {
  const m = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(m) && m > 0 ? m : undefined;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const sameName = (a?: string, b?: string) => !a || !b || a.trim().toLowerCase() === b.trim().toLowerCase();

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

const dated = (e: EpisodeRef): number | undefined => {
  const t = e.released ? Date.parse(e.released) : NaN;
  return Number.isFinite(t) ? t : undefined;
};

/** `into` with whatever it lacks taken from another listing of the same video. */
function fill(into: EpisodeRef, from: EpisodeRef) {
  if (!into.id) into.id = from.id;
  into.title ??= from.title;
  into.released ??= from.released;
  into.thumbnail ??= from.thumbnail;
  into.runtime ??= from.runtime;
  into.overview ??= from.overview;
}

/** Whether a season's `tail` (numbered far past `run`) is extras and not more episodes. */
function looksLikeExtras(season: number, run: EpisodeRef[], tail: EpisodeRef[], nextPremiere: number | undefined): boolean {
  // Dated outside the season: before it began, or once the next one had (or long after it ended).
  const runDates = run.map(dated).filter((d): d is number => d !== undefined);
  const tailDates = tail.map(dated).filter((d): d is number => d !== undefined);
  if (runDates.length && tailDates.length) {
    const start = Math.min(...runDates);
    const end = Math.max(...runDates);
    const until = nextPremiere !== undefined && nextPremiere > end ? nextPremiere : end + AFTER_SEASON_MS;
    const outside = tailDates.filter((d) => d < start - BEFORE_SEASON_MS || d >= until).length;
    if (outside * 2 >= tailDates.length) return true;
  }
  // Much shorter than the episodes.
  const runTime = median(run.map((e) => e.runtime).filter((m): m is number => m !== undefined));
  const tailTime = median(tail.map((e) => e.runtime).filter((m): m is number => m !== undefined));
  if (runTime !== undefined && tailTime !== undefined && tailTime * 2 <= runTime) return true;
  // The episodes have stills and none of these do. Not for what is dated after the run: episodes
  // still to come have no stills yet either.
  const upcoming = runDates.length > 0 && tailDates.some((d) => d > Math.max(...runDates));
  if (!upcoming && run.filter((e) => e.thumbnail).length * 5 >= run.length * 4 && tail.every((e) => !e.thumbnail)) return true;
  // Named like extras, or after another season ("Season 3 Behind the Story" inside season 1).
  const named = tail.filter((e) => e.title && (EXTRA_NAMES.test(e.title) || otherSeasonNamed(e.title, season))).length;
  return named * 2 >= tail.length && named > 0;
}

function otherSeasonNamed(title: string, season: number): boolean {
  const m = /\bseason\s+(\d+)\b/i.exec(title);
  return !!m && Number(m[1]) !== season;
}

/** One numbered season's entries (in order) split into its episodes and its extras. */
function splitSeason(season: number, list: EpisodeRef[], nextPremiere: number | undefined): { episodes: EpisodeRef[]; extras: EpisodeRef[] } {
  // A second video under a number already taken was marked while the list was read.
  const extras = list.filter((e) => e.extra);
  let episodes = list.filter((e) => !e.extra);

  // The run ends at the first jump in numbering wider than RUN_BREAK and than the run so far.
  // What follows is extras when it also looks the part; otherwise it is more episodes.
  let cut = -1;
  for (let i = 1; i < episodes.length; i++) {
    if (episodes[i].episode - episodes[i - 1].episode > Math.max(RUN_BREAK, i)) {
      cut = i;
      break;
    }
  }
  if (cut > 0) {
    const run = episodes.slice(0, cut);
    const tail = episodes.slice(cut);
    if (looksLikeExtras(season, run, tail, nextPremiere)) {
      extras.push(...tail);
      episodes = run;
    }
  } else if (nextPremiere !== undefined) {
    // Numbered straight on from the last episode: only what was released once the next season
    // had begun, and is also short or named like an extra. Never more than half the season.
    const typical = median(episodes.map((e) => e.runtime).filter((m): m is number => m !== undefined));
    let end = episodes.length;
    while (end > 1) {
      const e = episodes[end - 1];
      const at = dated(e);
      const late = at !== undefined && at >= nextPremiere;
      const short = typical !== undefined && e.runtime !== undefined && e.runtime * 2 <= typical;
      const named = !!e.title && (EXTRA_NAMES.test(e.title) || otherSeasonNamed(e.title, season));
      if (!(late && (short || named))) break;
      end--;
    }
    if (end < episodes.length && end * 2 >= episodes.length) {
      extras.push(...episodes.slice(end));
      episodes = episodes.slice(0, end);
    }
  }
  extras.sort((a, b) => a.episode - b.episode);
  for (const e of extras) e.extra = true;
  return { episodes, extras };
}

/** The guide for a show's `videos` (see the rule at the top of this file). */
export function buildGuide(videos: readonly Video[] | null | undefined): EpisodeGuide {
  if (!Array.isArray(videos) || !videos.length) return EMPTY;
  const byId = new Map<string, EpisodeRef>();
  const bySlot = new Map<string, EpisodeRef>();
  const numbered: EpisodeRef[] = [];
  const unnumbered: EpisodeRef[] = [];

  for (const v of videos) {
    if (!v || typeof v !== 'object') continue;
    const id = typeof v.id === 'string' ? v.id : v.id === undefined || v.id === null ? '' : String(v.id);
    const inId = id ? parseId(id) : { base: '' };
    const episode = num(v.episode) ?? num(v.number) ?? inId.episode;
    const season = num(v.season) ?? inId.season ?? (episode !== undefined ? 1 : undefined);
    const ref: EpisodeRef = {
      id,
      season: season ?? 0,
      episode: episode ?? NaN,
      released: text(v.released),
      title: text(v.name) ?? text(v.title),
      thumbnail: text(v.thumbnail),
      runtime: minutes(v.runtime),
      overview: text(v.overview) ?? text(v.description),
    };

    // The same id again is the same video. Where its two listings disagree on the numbers, the
    // one its id agrees with stands.
    const listed = id ? byId.get(id) : undefined;
    if (listed) {
      const agrees = episode !== undefined && inId.episode === episode && (inId.season === undefined || inId.season === ref.season);
      const moved = agrees && Number.isFinite(listed.episode) && (listed.season !== ref.season || listed.episode !== ref.episode) && !bySlot.has(`${ref.season}:${ref.episode}`);
      if (moved) {
        bySlot.delete(`${listed.season}:${listed.episode}`);
        listed.season = ref.season;
        listed.episode = ref.episode;
        bySlot.set(`${ref.season}:${ref.episode}`, listed);
      }
      // Listed without a number before, with one now.
      const slotFree = episode !== undefined && !bySlot.has(`${ref.season}:${ref.episode}`);
      if (!Number.isFinite(listed.episode) && slotFree) {
        unnumbered.splice(unnumbered.indexOf(listed), 1);
        listed.season = ref.season;
        listed.episode = ref.episode;
        bySlot.set(`${ref.season}:${ref.episode}`, listed);
        numbered.push(listed);
      }
      fill(listed, ref);
      continue;
    }
    if (episode === undefined) {
      if (id) byId.set(id, ref);
      unnumbered.push(ref);
      continue;
    }
    const slot = `${ref.season}:${ref.episode}`;
    const taken = bySlot.get(slot);
    if (taken && sameName(taken.title, ref.title)) {
      // The same episode listed twice (under a second id, or none).
      fill(taken, ref);
      if (id) byId.set(id, taken);
      continue;
    }
    // A different video claiming a number already taken: kept, beside the season's episodes.
    if (taken && ref.season > 0) ref.extra = true;
    if (!taken) bySlot.set(slot, ref);
    if (id) byId.set(id, ref);
    numbered.push(ref);
  }

  const groups = new Map<number, EpisodeRef[]>();
  for (const e of numbered) {
    const list = groups.get(e.season);
    if (list) list.push(e);
    else groups.set(e.season, [e]);
  }
  // Videos with no number at all go with the Specials, after the numbered ones, oldest first.
  if (unnumbered.length) {
    const specials = groups.get(0) ?? [];
    let next = Math.floor(Math.max(0, ...specials.map((e) => e.episode))) + 1;
    const order = unnumbered.map((e, i) => ({ e, i, at: dated(e) ?? Infinity })).sort((a, b) => a.at - b.at || a.i - b.i);
    for (const { e } of order) {
      e.season = 0;
      e.episode = next++;
      specials.push(e);
    }
    groups.set(0, specials);
  }
  // Stable: two videos under one number stay in the order the addon listed them.
  for (const list of groups.values()) list.sort((a, b) => a.episode - b.episode);

  const numbers = [...groups.keys()].filter((s) => s > 0).sort((a, b) => a - b);
  const seasons: SeasonGroup[] = numbers.map((season, i) => {
    const next = groups.get(numbers[i + 1]);
    const nextPremiere = next?.filter((e) => !e.extra).map(dated).find((d) => d !== undefined);
    return { season, ...splitSeason(season, groups.get(season)!, nextPremiere) };
  });
  const specials = groups.get(0);
  if (specials?.length) seasons.push({ season: 0, episodes: specials, extras: [] });

  const main = seasons.filter((g) => g.season > 0).flatMap((g) => g.episodes);
  const all = seasons.flatMap((g) => [...g.episodes, ...g.extras]);
  const used = new Set<string>();
  for (const e of all) {
    let key = `${e.season}:${e.episode}`;
    for (let n = 2; used.has(key); n++) key = `${e.season}:${e.episode}#${n}`;
    used.add(key);
    e.key = key;
  }
  return { seasons, main, all };
}

/**
 * The running order of a list of episodes: numbered seasons only, without extras, in order.
 * "What comes next" is always worked out over this.
 */
export function runningOrder(episodes: readonly EpisodeRef[]): EpisodeRef[] {
  return episodes.filter((e) => e.season > 0 && !e.extra).sort(byOrder);
}

/** A list key for an episode row: the guide's own, or one made from what the episode has. */
export function episodeKey(e: EpisodeRef, index: number): string {
  return e.key ?? `${e.season}:${e.episode}:${e.id}:${index}`;
}

/** What a season's tab or menu entry is called. */
export function seasonLabel(season: number): string {
  return season === 0 ? 'Specials' : `Season ${season}`;
}
