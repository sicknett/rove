// In-app navigation: a history stack with back/forward. Recent screens stay mounted (hidden),
// so going back is instant and keeps scroll position and loaded rows.

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
    if (stack[index].route.name === route.name && Object.keys(route).length === 1) {
      // Same tab again: back to its top.
      window.dispatchEvent(new CustomEvent('rove:scroll-top'));
      return;
    }
    get().push(route);
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
