// "Reset this section", worked out from the stored preferences a section controls: which of
// them differ from the defaults, the changes that put them back, and the changes that undo that.

import type { Settings } from '../../state/settings';
import type { SettingPath } from './catalog';

type Part = keyof Settings;

/** Changes to hand to the settings store, one object per part of the settings document. */
export type Patches = { [S in Part]?: Partial<Settings[S]> };

function split(path: SettingPath): [Part, string] {
  const dot = path.indexOf('.');
  return [path.slice(0, dot) as Part, path.slice(dot + 1)];
}

export function valueAt(settings: Settings, path: SettingPath): unknown {
  const [part, key] = split(path);
  return (settings[part] as Record<string, unknown>)[key];
}

/** Lists (the language orders) are equal when they hold the same things in the same order. */
const same = (a: unknown, b: unknown) => (Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : a === b);

/** The preferences among `paths` whose value is not the default. */
export function changedPaths(settings: Settings, defaults: Settings, paths: SettingPath[]): SettingPath[] {
  return paths.filter((p) => !same(valueAt(settings, p), valueAt(defaults, p)));
}

/** The values `source` has at `paths`, grouped the way the store takes them. Lists are copied. */
export function patchesFrom(source: Settings, paths: SettingPath[]): Patches {
  const out: Record<string, Record<string, unknown>> = {};
  for (const p of paths) {
    const [part, key] = split(p);
    const value = valueAt(source, p);
    (out[part] ??= {})[key] = Array.isArray(value) ? [...value] : value;
  }
  return out as Patches;
}

/**
 * What a reset of `paths` does and how to take it back: `apply` holds the defaults for the
 * preferences that differ, `undo` their values now. Null when nothing differs. Undo touches
 * only what the reset touched, so a change made in between is kept.
 */
export function planReset(settings: Settings, defaults: Settings, paths: SettingPath[]): { changed: SettingPath[]; apply: Patches; undo: Patches } | null {
  const changed = changedPaths(settings, defaults, paths);
  if (!changed.length) return null;
  return { changed, apply: patchesFrom(defaults, changed), undo: patchesFrom(settings, changed) };
}

export function applyPatches(set: <S extends Part>(part: S, patch: Partial<Settings[S]>) => void, patches: Patches) {
  for (const part of Object.keys(patches) as Part[]) set(part, patches[part] as never);
}
