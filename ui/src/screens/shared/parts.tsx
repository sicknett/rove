// Small pieces the browsing screens share.

import { catalogNeeds, genreOptions } from '../../addons/client';
import type { ManifestCatalog } from '../../addons/types';
import { BUILT_IN_TMDB_KEY, tmdbKeyId, useKeys } from '../../state/keys';
import { Button, Empty } from '../../ui/controls';

/** Something that should have loaded did not (as opposed to loading and being empty). */
export function LoadFailed({ title, onRetry, children }: { title: string; onRetry: () => void; children?: React.ReactNode }) {
  return (
    <Empty
      title={title}
      action={
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      }
    >
      {children}
    </Empty>
  );
}

/** An addon catalog's own genres, one at a time. */
export function GenreChips({ catalog, value, onChange }: { catalog: ManifestCatalog; value?: string; onChange: (g?: string) => void }) {
  const genres = genreOptions(catalog);
  const required = catalogNeeds(catalog).includes('genre');
  if (!genres.length) return null;
  return (
    <div className="chips chips--scroll" role="radiogroup" aria-label="Genre">
      {!required && (
        <button role="radio" aria-checked={!value} className={`chip ${!value ? 'is-on' : ''}`} onClick={() => onChange(undefined)}>
          All
        </button>
      )}
      {genres.map((g) => (
        <button key={g} role="radio" aria-checked={value === g} className={`chip ${value === g ? 'is-on' : ''}`} onClick={() => onChange(g)}>
          {g}
        </button>
      ))}
    </div>
  );
}

/**
 * The TMDB key in use, as the fingerprint cache keys carry, or null without one. Screens use it
 * both to know whether TMDB can be asked at all and to ask again once the key changes.
 */
export function useTmdbKeyId(): string | null {
  return useKeys((s) => {
    const key = s.tmdbApiKey ?? BUILT_IN_TMDB_KEY;
    return key ? tmdbKeyId(key) : null;
  });
}
