// In-app navigation: a history stack with back/forward. Recent screens stay mounted (hidden),
// so going back is instant and keeps scroll position and loaded rows.

import { createContext, useContext } from 'react';
import { create } from 'zustand';

export type Route =
  | { name: 'home' }
  | { name: 'discover'; type?: string; catalog?: string; genre?: string }
  | { name: 'search'; q?: string }
  | { name: 'library'; tab?: 'watchlist' | 'continue' | 'history' | 'collections' }
  | { name: 'calendar' }
  | { name: 'title'; type: string; id: string; season?: number }
  | { name: 'catalog'; addonId: string; type: string; catalogId: string; title?: string; genre?: string }
  | { name: 'collection'; id: string; folder?: string }
  | { name: 'collection-edit'; id: string; folder?: string }
  /** Every title of a list that is a row on Home (its "See all"). */
  | { name: 'list'; id: string }
  | { name: 'person'; id: number; label?: string }
  | { name: 'settings'; section?: string };

export type RouteName = Route['name'];

export interface Entry {
  key: number;
  route: Route;
}

interface NavState {
  stack: Entry[];
  index: number;
  push: (route: Route) => void;
  replace: (route: Route) => void;
  back: () => void;
  forward: () => void;
  /** Top-level destinations (sidebar) reuse an existing entry instead of piling up. */
  goTab: (route: Route) => void;
  /** Takes pages of something that no longer exists (a deleted collection) out of history. */
  drop: (gone: (route: Route) => boolean) => void;
}

let nextKey = 1;
const MAX_STACK = 60;

export const sameRoute = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b);

export const useNav = create<NavState>((set, get) => ({
  stack: [{ key: 0, route: { name: 'home' } }],
  index: 0,

  push(route) {
    const { stack, index } = get();
    if (sameRoute(stack[index].route, route)) return;
    const kept = stack.slice(0, index + 1);
    const next = [...kept, { key: nextKey++, route }].slice(-MAX_STACK);
    set({ stack: next, index: next.length - 1 });
  },

  replace(route) {
    const { stack, index } = get();
    if (sameRoute(stack[index].route, route)) return;
    // Same screen, new parameters: it updates in place (no remount, no lost state).
    const next = [...stack];
    next[index] = { key: stack[index].key, route };
    set({ stack: next });
  },

  back() {
    const { index } = get();
    if (index > 0) set({ index: index - 1 });
  },

  forward() {
    const { index, stack } = get();
    if (index < stack.length - 1) set({ index: index + 1 });
  },

  goTab(route) {
    const { stack, index } = get();
    if (stack[index].route.name === route.name) {
      // Same tab again: back to its top.
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('rove:scroll-top'));
      return;
    }
    // The tab's latest screen comes back to the front under its own key, so it is the same
    // screen (scroll and state kept while it is still mounted) and not another copy. It moves
    // to the top of the stack, as a push would put it, so Back returns to where the user was.
    let at = -1;
    for (let i = stack.length - 1; i >= 0 && at < 0; i--) if (stack[i].route.name === route.name) at = i;
    if (at < 0) return get().push(route);
    const next = [...stack.slice(0, index + 1).filter((e) => e.key !== stack[at].key), stack[at]];
    set({ stack: next, index: next.length - 1 });
  },

  drop(gone) {
    const { stack, index } = get();
    if (!stack.some((e) => gone(e.route))) return;
    const kept = stack.filter((e) => !gone(e.route));
    if (!kept.length) return set({ stack: [{ key: nextKey++, route: { name: 'home' } }], index: 0 });
    // Land on the current page if it survives, else on the nearest one before it.
    const before = stack.slice(0, index + 1).filter((e) => !gone(e.route)).length;
    set({ stack: kept, index: Math.max(0, before - 1) });
  },
}));

export const navigate = (route: Route) => useNav.getState().push(route);
export const goBack = () => useNav.getState().back();

export function currentRoute(): Route {
  const { stack, index } = useNav.getState();
  return stack[index].route;
}

/** Entries to keep mounted: the current one and the few before it. */
export function mountedEntries(stack: Entry[], index: number, keep = 6): Entry[] {
  return stack.slice(Math.max(0, index - keep + 1), index + 1);
}

/**
 * What a screen knows about its place in history: its entry's key, and whether it is the one on
 * show (false while it waits in history, and while video plays over the app).
 */
export const ScreenContext = createContext<{ key: number; active: boolean }>({ key: -1, active: true });
export const useScreen = () => useContext(ScreenContext);
