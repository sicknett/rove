// What a title card can do from its menu: open, play, watchlist, watched marks, remove from
// Continue Watching.

import { Bookmark, BookmarkCheck, CheckCircle2, CircleSlash, Info, Play, X } from 'lucide-react';
import type { MenuItem } from '../ui/controls';
import { navigate } from '../nav/router';
import { useHistory, type MediaType } from '../state/history';
import { toggleWatchlist } from '../library/watchlist';
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

export function titleMenu(t: CardTitle, extra: { onPlay?: () => void; continueKey?: string; season?: number; episode?: number } = {}): (MenuItem | 'divider')[] {
  const h = useHistory.getState();
  const inList = !!h.library[t.metaId];
  const isMovieWatched = t.type === 'movie' && !!h.watched[t.metaId];
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
      onSelect: () => {
        if (isMovieWatched) h.unmarkWatched([{ metaId: t.metaId, type: 'movie' }]);
        else h.markWatched([{ metaId: t.metaId, type: 'movie' }]);
        toast.success(isMovieWatched ? `${t.name ?? 'Title'} marked unwatched` : `${t.name ?? 'Title'} marked watched`);
      },
    });
  } else if (extra.season !== undefined && extra.episode !== undefined) {
    const s = extra.season;
    const e = extra.episode;
    items.push({
      label: `Mark S${s} E${e} watched`,
      icon: <CheckCircle2 size={16} />,
      onSelect: () => {
        h.markWatched([{ metaId: t.metaId, type: 'series', season: s, episode: e }]);
        toast.success(`S${s} E${e} marked watched`);
      },
    });
  }
  if (extra.continueKey) {
    items.push('divider');
    items.push({
      label: 'Remove from Continue Watching',
      icon: <X size={16} />,
      onSelect: () => {
        h.dismiss(t.metaId);
        toast.info(`${t.name ?? 'Title'} removed from Continue Watching`, { label: 'Undo', run: () => useHistory.getState().undismiss(t.metaId) });
      },
    });
  }
  return items;
}
