// The watchlist: kept locally per profile, and mirrored to the chosen tracker's watchlist when it
// has one. Adds and removals go there through the history outbox (so one made offline is sent
// later); its list is merged in on every sync (tracking/sync.ts).

import { titleKey, tmdbTitleNumber } from '../addons/ids';
import { useHistory, type MediaType } from '../state/history';
import { canonicalId, canonicalNow } from '../tracking/idmap';
import { toast } from '../ui/toast';
import type { CardTitle } from '../media/actions';

/** How long a toggle waits to learn a `tmdb:` card's IMDb id before going ahead with the id it has. */
const ID_WAIT_MS = 3000;

export async function toggleWatchlist(t: CardTitle): Promise<boolean> {
  // The list is kept under the title's history id, so the same title added from an IMDb card and
  // from a TMDB one is one entry, not two.
  const metaId = await canonicalId(t.metaId, t.type, { timeoutMs: ID_WAIT_MS });
  const added = useHistory.getState().toggleLibrary({ metaId, type: t.type, tmdbId: tmdbTitleNumber(t.metaId) ?? undefined, name: t.name, poster: t.poster, background: t.background, logo: t.logo, year: t.year });
  toast.success(added ? `${t.name ?? 'Title'} added to your Watchlist` : `${t.name ?? 'Title'} removed from your Watchlist`);
  return added;
}

/** Whether a title is on the watchlist, whichever of its ids the card carries. */
export function useInWatchlist(metaId: string, type: MediaType): boolean {
  return useHistory((s) => !!s.library[titleKey(canonicalNow(metaId, type), type)]);
}
