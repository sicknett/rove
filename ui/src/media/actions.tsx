// What a title card can do from its menu: open, play, watchlist, watched marks, remove from
// Continue Watching.

import { Bookmark, BookmarkCheck, CheckCircle2, CircleSlash, Info, Play, X } from 'lucide-react';
import type { MenuItem } from '../ui/controls';
import { titleKey, tmdbTitleNumber } from '../addons/ids';
import { navigate } from '../nav/router';
import { useHistory, WATCHED_PERCENT, type MediaType } from '../state/history';
import { toggleWatchlist } from '../library/watchlist';
import { canonicalId, canonicalNow } from '../tracking/idmap';
import { toast } from '../ui/toast';

export interface CardTitle {
  metaId: string;
  type: MediaType;
  name?: string;
  poster?: string;
  background?: string;
  logo?: string;
  year?: string;
}

/**
 * Runs a change to history once the card's title has its history id. History puts every write
 * under the IMDb id the id map knows; a `tmdb:` card it has not seen yet is looked up first, so
 * the mark does not land under an id nothing else uses. With no answer in a few seconds the
 * change goes ahead as it is, and moves over when the mapping is learned.
 */
function whenMapped(t: CardTitle, change: () => void) {
  if (tmdbTitleNumber(canonicalNow(t.metaId, t.type)) === null) return change();
  void canonicalId(t.metaId, t.type, { timeoutMs: 3000 }).then(change);
}

export function titleMenu(t: CardTitle, extra: { onPlay?: () => void; continueKey?: string; season?: number; episode?: number } = {}): (MenuItem | 'divider')[] {
  const h = useHistory.getState();
  const id = canonicalNow(t.metaId, t.type);
  const inList = !!h.library[titleKey(id, t.type)];
  const isMovieWatched = t.type === 'movie' && !!h.watched[id];
  const items: (MenuItem | 'divider')[] = [];
  if (extra.onPlay) items.push({ label: extra.season !== undefined ? `Play S${extra.season} E${extra.episode}` : 'Play', icon: <Play size={16} />, onSelect: extra.onPlay });
  items.push({ label: 'Details', icon: <Info size={16} />, onSelect: () => navigate({ name: 'title', type: t.type, id: t.metaId }) });
  items.push('divider');
  items.push({
    label: inList ? 'Remove from Watchlist' : 'Add to Watchlist',
    icon: inList ? <BookmarkCheck size={16} /> : <Bookmark size={16} />,
    onSelect: () => void toggleWatchlist(t),
  });
  if (t.type === 'movie') {
    items.push({
      label: isMovieWatched ? 'Mark as unwatched' : 'Mark as watched',
      icon: isMovieWatched ? <CircleSlash size={16} /> : <CheckCircle2 size={16} />,
      onSelect: () =>
        whenMapped(t, () => {
          if (isMovieWatched) h.unmarkWatched([{ metaId: t.metaId, type: 'movie' }]);
          else h.markWatched([{ metaId: t.metaId, type: 'movie' }]);
          toast.success(isMovieWatched ? `${t.name ?? 'Title'} marked unwatched` : `${t.name ?? 'Title'} marked watched`);
        }),
    });
  } else if (extra.season !== undefined && extra.episode !== undefined) {
    const s = extra.season;
    const e = extra.episode;
    items.push({
      label: `Mark S${s} E${e} watched`,
      icon: <CheckCircle2 size={16} />,
      onSelect: () =>
        whenMapped(t, () => {
          h.markWatched([{ metaId: t.metaId, type: 'series', season: s, episode: e }]);
          toast.success(`S${s} E${e} marked watched`);
        }),
    });
  }
  if (extra.continueKey) {
    const key = extra.continueKey;
    items.push('divider');
    items.push({
      label: 'Remove from Continue Watching',
      icon: <X size={16} />,
      onSelect: () => {
        const now = useHistory.getState();
        const resume = now.progress[key];
        now.dismiss(t.metaId, t.type);
        // A resume point is cleared on the tracker as well. Left there it would come back with
        // the next sync, and stay in Continue Watching on every other device.
        if (resume) now.clearProgress(key);
        toast.info(`${t.name ?? 'Title'} removed from Continue Watching`, {
          label: 'Undo',
          run: () => {
            const again = useHistory.getState();
            again.undismiss(t.metaId, t.type);
            // Saving it again restores the resume point and sends it back to the tracker.
            if (resume && (resume.positionS / resume.durationS) * 100 < WATCHED_PERCENT) again.recordProgress(resume);
          },
        });
      },
    });
  }
  return items;
}
