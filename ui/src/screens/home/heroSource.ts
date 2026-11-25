// What the banner features when the user picks something of their own instead of catalog rows.

import { useMemo } from 'react';
import type { MetaPreview } from '../../addons/types';
import { useContinueWatching } from '../../data/hooks';
import { useHistory } from '../../state/history';
import { useSettings } from '../../state/settings';

/**
 * Titles for the banner from Continue Watching or the watchlist, or null when the banner follows
 * the rows (the "Automatic" choice) or the chosen list is empty, so Home falls back to the rows.
 */
export function usePersonalHeroItems(): MetaPreview[] | null {
  const source = useSettings((s) => s.settings.appearance.heroSource);
  const { items: continuing } = useContinueWatching(8);
  const library = useHistory((s) => s.library);
  return useMemo(() => {
    if (source === 'continue') {
      const items = continuing.filter((c) => c.name).map((c) => ({ id: c.metaId, type: c.type, name: c.name!, poster: c.poster, background: c.background, logo: c.logo }) as MetaPreview);
      return items.length ? items : null;
    }
    if (source === 'watchlist') {
      const items = Object.values(library)
        .sort((a, b) => b.addedAt - a.addedAt)
        .slice(0, 8)
        .map((l) => ({ id: l.metaId, type: l.type, name: l.name ?? '', poster: l.poster, background: l.background, logo: l.logo }) as MetaPreview)
        .filter((m) => m.name);
      return items.length ? items : null;
    }
    return null;
  }, [source, continuing, library]);
}
