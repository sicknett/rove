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
  ensure: (keys: string[]) => void;
  setRow: (key: string, patch: Partial<RowPref>) => void;
  moveRow: (key: string, toIndex: number, visibleKeys: string[]) => void;
  setHeroEnabled: (v: boolean) => void;
  reset: () => void;
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

    ensure(keys) {
      const known = new Set(get().items.map((i) => i.key));
      const missing = keys.filter((k) => !known.has(k));
      if (!missing.length) return;
      let order = Math.max(-1, ...get().items.map((i) => i.order)) + 1;
      const heroCount = get().items.filter((i) => i.hero).length;
      const added = missing.map((key, i) => ({
        key,
        enabled: true,
        order: key === CONTINUE_KEY ? -1 : order++,
        hero: key !== CONTINUE_KEY && !key.startsWith('collection_') && !key.startsWith('server:') && heroCount + i < 2,
      }));
      commit({ items: [...get().items, ...added] });
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

    reset() {
      commit({ heroEnabled: true, items: [] });
    },
  };
});

export function flushHomeLayout() {
  return writer.flush();
}
