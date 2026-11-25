// Which rows Home shows, in what order, under what names. Keys: `<addonId>:<type>:<catalogId>`
// for catalogs, `collection_<id>` for collections, and `continue_watching`.

import { create } from 'zustand';
import { debouncedWriter, docs } from '../lib/native';
import { profileDoc } from './profiles';

export const CONTINUE_KEY = 'continue_watching';

export interface RowPref {
  key: string;
  enabled: boolean;
  customTitle?: string;
  order: number;
  /** Feeds the hero banner. */
  hero?: boolean;
  shape?: 'poster' | 'wide';
}

interface LayoutDoc {
  heroEnabled: boolean;
  items: RowPref[];
}

interface LayoutState extends LayoutDoc {
  loaded: boolean;
  load: () => Promise<void>;
  /** Adds rows that appeared (new addon or collection) at the end, enabled. */
  ensure: (keys: string[], pinned?: string[]) => void;
  setRow: (key: string, patch: Partial<RowPref>) => void;
  moveRow: (key: string, toIndex: number, visibleKeys: string[]) => void;
  setHeroEnabled: (v: boolean) => void;
  /** Back to the default layout for the rows that exist now (`keys` and `pinned` as for `ensure`). */
  reset: (keys?: string[], pinned?: string[]) => void;
}

let writer = debouncedWriter((v) => docs.write(profileDoc('home'), v), 500);

export const useHomeLayout = create<LayoutState>((set, get) => {
  const commit = (patch: Partial<LayoutDoc>) => {
    set(patch);
    writer.save({ heroEnabled: get().heroEnabled, items: get().items });
  };
  return {
    loaded: false,
    heroEnabled: true,
    items: [],

    async load() {
      writer.flush();
      const name = profileDoc('home');
      writer = debouncedWriter((v) => docs.write(name, v), 500);
      const doc = await docs.read<LayoutDoc>(name).catch(() => null);
      set({ loaded: true, heroEnabled: doc?.heroEnabled ?? true, items: doc?.items ?? [] });
    },

    ensure(keys, pinned = []) {
      const known = new Set(get().items.map((i) => i.key));
      const missing = keys.filter((k) => !known.has(k));
      if (!missing.length) return;
      const heroCount = get().items.filter((i) => i.hero).length;
      const make = (key: string, i: number): RowPref => ({
        key,
        enabled: true,
        order: 0,
        hero: key !== CONTINUE_KEY && !key.startsWith('collection_') && !key.startsWith('server:') && heroCount + i < 2,
      });
      const added = missing.map(make);
      const pin = new Set(pinned);
      // Continue Watching first, then pinned collections, then what was there, then the rest.
      const ordered = [...get().items].sort((a, b) => a.order - b.order);
      const cw = added.find((i) => i.key === CONTINUE_KEY);
      if (cw) ordered.unshift(cw);
      const top = ordered.findIndex((i) => i.key === CONTINUE_KEY) + 1;
      ordered.splice(top, 0, ...added.filter((i) => pin.has(i.key)));
      ordered.push(...added.filter((i) => i.key !== CONTINUE_KEY && !pin.has(i.key)));
      commit({ items: ordered.map((i, n) => ({ ...i, order: n })) });
    },

    setRow(key, patch) {
      commit({ items: get().items.map((i) => (i.key === key ? { ...i, ...patch } : i)) });
    },

    moveRow(key, toIndex, visibleKeys) {
      const ordered = [...get().items].sort((a, b) => a.order - b.order).filter((i) => visibleKeys.includes(i.key));
      const from = ordered.findIndex((i) => i.key === key);
      if (from < 0) return;
      const [item] = ordered.splice(from, 1);
      ordered.splice(Math.max(0, Math.min(ordered.length, toIndex)), 0, item);
      const orderOf = new Map(ordered.map((i, idx) => [i.key, idx]));
      const rest = get().items.filter((i) => !orderOf.has(i.key));
      commit({ items: [...ordered.map((i) => ({ ...i, order: orderOf.get(i.key)! })), ...rest.map((i, n) => ({ ...i, order: ordered.length + n }))] });
    },

    setHeroEnabled(v) {
      commit({ heroEnabled: v });
    },

    reset(keys = [], pinned = []) {
      commit({ heroEnabled: true, items: [] });
      // Built again straight away: an emptied layout shows no rows at all until something adds them.
      get().ensure(keys, pinned);
    },
  };
});

export function flushHomeLayout() {
  return writer.flush();
}
