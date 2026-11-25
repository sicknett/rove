// What the screens read: which rows exist (for Home and Settings → Home layout), and what one
// row shows.

import { useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { titleKey } from '../addons/ids';
import { useCardArt } from '../data/hooks';
import { useScreen } from '../nav/router';
import { useHistory, type LibraryItem } from '../state/history';
import { BUILT_IN_TMDB_KEY, useKeys } from '../state/keys';
import { useProfiles } from '../state/profiles';
import { useSettings } from '../state/settings';
import { useRecs, type BoardRow } from './engine';
import { isoDay, rowLabel, SMART_KEYS, WATCHLIST_ROW, type RecipeContext } from './recipes';
import { unstartedWatchlist } from './taste';

export interface SmartRowDef {
  key: string;
  title: string;
  /** The line under the row's name in Settings → Home layout. */
  detail: string;
}

const NO_ROWS: SmartRowDef[] = [];

/** Whether the rows exist at all: switched on in Settings, and with a TMDB key to ask with. */
export function useSmartRowsOn(): boolean {
  const on = useSettings((s) => s.settings.appearance.smartRows);
  const tmdbKey = useKeys((s) => s.tmdbApiKey ?? BUILT_IN_TMDB_KEY);
  return on && !!tmdbKey;
}

/**
 * The rows made from the profile's history, in the order they first appear on Home, each under
 * its current name ("Because you watched Severance", "Crime shows for you"). Every row is
 * listed whether or not it has something to show today, so each keeps its place in the layout:
 * the layout is arranged once, when the rows first appear, and a row that turned up later would
 * land in the wrong place. Empty when the rows are switched off, or without a TMDB key.
 */
export function useSmartRowDefs(): SmartRowDef[] {
  const on = useSmartRowsOn();
  const profileId = useProfiles((s) => s.activeId);
  const kids = useProfiles((s) => !!s.profiles.find((p) => p.id === s.activeId)?.kids);
  const loaded = useRecs((s) => !!profileId && s.profileId === profileId);
  const taste = useRecs((s) => s.doc.taste);
  const because = useRecs((s) => s.doc.because);

  useEffect(() => {
    if (on && profileId) void useRecs.getState().load(profileId);
  }, [on, profileId]);

  return useMemo(() => {
    if (!on) return NO_ROWS;
    const ctx: RecipeContext = { taste: loaded ? taste : null, because: loaded ? because?.picks ?? [] : [], kids, today: isoDay(Date.now()) };
    return SMART_KEYS.map((key) => ({ key, ...rowLabel(key, ctx) }));
  }, [on, loaded, taste, because, kids]);
}

/**
 * One row's state. `near` is whether the row has come near the screen: until then nothing is
 * asked for on its account. Undefined until the profile's saved recommendations have been read.
 */
export function useSmartRow(key: string, near: boolean): BoardRow | undefined {
  const client = useQueryClient();
  const profileId = useProfiles((s) => s.activeId);
  const ready = useRecs((s) => !!profileId && s.profileId === profileId);
  // Home stays mounted while other screens are open: what is due is refreshed when it comes
  // back on show, not while it waits in history.
  const { active } = useScreen();

  useEffect(() => useRecs.getState().bind(client), [client]);

  useEffect(() => {
    if (!ready) return;
    useRecs.getState().setNear(key, near);
    return () => useRecs.getState().setNear(key, false);
  }, [key, near, ready]);

  useEffect(() => {
    if (ready && near && active) useRecs.getState().visit();
  }, [ready, near, active]);

  return useRecs((s) => (ready ? s.board[key] : undefined));
}

/** A row's whole list, for "See all". Fetched while the page is open. */
export function useSmartList(key: string): BoardRow | undefined {
  const client = useQueryClient();
  const profileId = useProfiles((s) => s.activeId);
  const ready = useRecs((s) => !!profileId && s.profileId === profileId);
  const { active } = useScreen();

  useEffect(() => useRecs.getState().bind(client), [client]);

  useEffect(() => {
    if (profileId) void useRecs.getState().load(profileId);
  }, [profileId]);

  useEffect(() => {
    if (!ready) return;
    useRecs.getState().setOpen(key, true);
    return () => useRecs.getState().setOpen(key, false);
  }, [key, ready]);

  useEffect(() => {
    if (ready && active) useRecs.getState().visit();
  }, [ready, active]);

  return useRecs((s) => (ready ? s.full[key] : undefined));
}

/** How many titles were marked Not interested, for Settings. */
export function useHiddenCount(): number {
  const profileId = useProfiles((s) => s.activeId);
  return useRecs((s) => (!!profileId && s.profileId === profileId ? Object.keys(s.doc.hidden).length : 0));
}

type WatchlistCard = LibraryItem;
const NO_ITEMS: WatchlistCard[] = [];

/**
 * "From your watchlist": titles on the watchlist with nothing watched yet, newest first, with
 * the art remembered for them. Empty unless there are enough to make a row.
 */
export function useWatchlistRow(): WatchlistCard[] {
  const watched = useHistory((s) => s.watched);
  const progress = useHistory((s) => s.progress);
  const library = useHistory((s) => s.library);
  const cards = useHistory((s) => s.cards);
  // Positions are saved every few seconds while something plays; only which titles have one matters.
  const started = Object.keys(progress).length;
  const unstarted = useMemo(
    () => unstartedWatchlist({ watched, progress, library }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [watched, library, started],
  );
  const items = useMemo(() => {
    if (unstarted.length < WATCHLIST_ROW.min) return NO_ITEMS;
    return unstarted.slice(0, WATCHLIST_ROW.limit).map((i) => {
      // An item a tracker sent may have no art of its own: the remembered card completes it.
      const c = cards[titleKey(i.metaId, i.type)];
      return { ...i, name: i.name ?? c?.name, poster: i.poster ?? c?.poster, background: i.background ?? c?.background, year: i.year ?? c?.year };
    });
  }, [unstarted, cards]);
  useCardArt(items);
  return items;
}
