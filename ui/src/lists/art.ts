// Posters for list titles. Trakt sends none it lets apps show (its images may not be hotlinked),
// and MDBList only sometimes, so they come from TMDB by the title's TMDB number: the same art a
// TMDB source's cards carry. A title TMDB cannot be asked about is left without, and the screen
// showing it fills it in from the metadata addons (see useCardArt).

import { tmdbIdOf } from '../addons/ids';
import { pool } from '../lib/http';
import { hasTmdb, tmdb, tmdbImage } from '../meta/tmdb';
import type { ListItem } from './types';

const WEEK = 7 * 24 * 3600 * 1000;
/** A page of titles is not held back for art longer than this; what has not answered goes without. */
const ART_BUDGET_MS = 4000;

/** MDBList sends a poster as a link or as a TMDB image path. */
export function posterLink(poster: string | undefined): string | undefined {
  if (!poster) return undefined;
  if (/^https?:\/\//i.test(poster)) return poster;
  return poster.startsWith('/') ? tmdbImage(poster, 'w342') : undefined;
}

/** `items` with TMDB's poster and backdrop for those that have none. Never fails. */
export async function withTmdbArt(items: ListItem[], budgetMs = ART_BUDGET_MS): Promise<ListItem[]> {
  if (!hasTmdb() || items.every((i) => i.poster)) return items;
  const out = [...items];
  const all = pool(items, 8, async (it, i) => {
    const id = it.tmdbId ?? tmdbIdOf(it.id);
    if (it.poster || !id) return;
    const d = await tmdb<{ poster_path?: string | null; backdrop_path?: string | null }>(`/${it.type === 'movie' ? 'movie' : 'tv'}/${id}`, {}, WEEK).catch(() => null);
    if (d) out[i] = { ...it, poster: tmdbImage(d.poster_path, 'w342'), background: it.background ?? tmdbImage(d.backdrop_path, 'w1280') };
  }).catch(() => undefined);
  await Promise.race([all, new Promise((done) => setTimeout(done, budgetMs))]);
  return [...out];
}
