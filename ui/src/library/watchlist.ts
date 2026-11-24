// The watchlist: kept locally per profile, and mirrored to the chosen tracker's watchlist when it
// has one (adds and removals go there; its list is merged in on every sync).

import { useHistory } from '../state/history';
import { useTracker, trackerName } from '../tracking/sync';
import { adapterFor } from '../tracking/adapters';
import { toast } from '../ui/toast';
import type { CardTitle } from '../media/actions';

export async function toggleWatchlist(t: CardTitle): Promise<boolean> {
  const added = useHistory.getState().toggleLibrary({ metaId: t.metaId, type: t.type, name: t.name, poster: t.poster, background: t.background, logo: t.logo, year: t.year });
  toast.success(added ? `${t.name ?? 'Title'} added to your Watchlist` : `${t.name ?? 'Title'} removed from your Watchlist`);
  const account = useTracker.getState().account;
  if (!account) return added;
  const adapter = adapterFor(account.provider);
  try {
    if (added) await adapter.watchlistAdd?.(account, t);
    else await adapter.watchlistRemove?.(account, t);
  } catch {
    toast.error(`The Watchlist change could not be sent to ${trackerName(account.provider)}. It is saved here.`);
  }
  return added;
}
