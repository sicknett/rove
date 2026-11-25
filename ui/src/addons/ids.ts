// Content ids across addons: `tt0944947`, `tt0944947:1:2`, `tmdb:1399`, `tmdb:1399:1:2`,
// `kitsu:1:5`, `mal:21:1000`, and whatever else an addon invents (`prefix:value[:s][:e]`).

/** Namespaces whose ids take two segments (`tmdb:1399`). */
const NAMESPACED = new Set(['tmdb', 'tvdb', 'kitsu', 'mal', 'anilist', 'anidb', 'imdb', 'trakt', 'simkl', 'tvmaze']);

export interface ParsedId {
  /** The title's id without episode parts (`tt0944947`, `tmdb:1399`, `kitsu:1`). */
  base: string;
  season?: number;
  episode?: number;
}

export function parseId(id: string): ParsedId {
  // Media server items (`srv:<server>:<item>`) are whole ids; episodes have their own item ids.
  if (id.startsWith('srv:')) return { base: id };
  const parts = id.split(':');
  const take = parts.length > 1 && NAMESPACED.has(parts[0].toLowerCase()) ? 2 : 1;
  const base = parts.slice(0, take).join(':');
  const rest = parts.slice(take).map((p) => Number(p));
  if (rest.length >= 2 && rest.every(Number.isFinite)) return { base, season: rest[0], episode: rest[1] };
  if (rest.length === 1 && Number.isFinite(rest[0])) return { base, episode: rest[0] };
  return { base: rest.length ? id : base };
}

export const isImdbId = (id: string) => /^tt\d+$/.test(id);

export function tmdbIdOf(id: string): number | null {
  const m = /^tmdb:(\d+)/i.exec(id);
  return m ? Number(m[1]) : null;
}

/** The prefix an addon's `idPrefixes` would be matched against. */
export function idMatchesPrefixes(id: string, prefixes: string[] | undefined): boolean {
  if (!prefixes || prefixes.length === 0) return true;
  return prefixes.some((p) => id.startsWith(p));
}

export function episodeId(base: string, season: number, episode: number) {
  return `${base}:${season}:${episode}`;
}

/** A stable key for progress and watched marks: the title id, plus season/episode for episodes. */
export function watchKey(metaId: string, season?: number, episode?: number): string {
  return season !== undefined && episode !== undefined ? `${metaId}:${season}:${episode}` : metaId;
}

/** The TMDB number of a bare `tmdb:<n>` title id (no episode parts), else null. */
export function tmdbTitleNumber(metaId: string): number | null {
  const m = /^tmdb:(\d+)$/i.exec(metaId);
  return m ? Number(m[1]) : null;
}

/**
 * The key for what is kept once per title (card art, watchlist, Continue Watching dismissals).
 * TMDB numbers movies and shows separately, so movie 693 and show 693 are different titles:
 * a `tmdb:` id carries its type. Every other id is its own key.
 */
export function titleKey(metaId: string, type: 'movie' | 'series'): string {
  return tmdbTitleNumber(metaId) !== null ? `${metaId.toLowerCase()}@${type}` : metaId;
}
