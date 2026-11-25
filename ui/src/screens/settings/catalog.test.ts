import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/native', () => ({
  docs: { read: async () => null, write: async () => undefined, remove: async () => undefined },
  secrets: { read: async () => null, write: async () => undefined, remove: async () => undefined },
  debouncedWriter: () => ({ save: () => undefined, flush: async () => undefined }),
}));

const { DEFAULT_SETTINGS } = await import('../../state/settings');
const { ENTRIES, SECTIONS, entryOf, resolveSection, sectionPaths } = await import('./catalog');
const { ago, count } = await import('./format');
const { applyPatches, changedPaths, planReset, valueAt } = await import('./reset');
type Settings = typeof DEFAULT_SETTINGS;

/** Every stored preference, as `<part>.<key>`. */
const ALL_PATHS = Object.entries(DEFAULT_SETTINGS).flatMap(([part, values]) => Object.keys(values).map((key) => `${part}.${key}`));

/** Preferences the app reads that have no control in Settings yet, on purpose or not. */
const WITHOUT_A_CONTROL = ['sources.pickerTimeoutSec'];

describe('the settings catalog', () => {
  it('gives every control its own id', () => {
    const seen = new Set<string>();
    for (const e of ENTRIES) {
      expect(seen.has(e.id), e.id).toBe(false);
      seen.add(e.id);
    }
  });

  it('puts every control in a section that exists', () => {
    const sections = new Set(SECTIONS.map((s) => s.id));
    for (const e of ENTRIES) expect(sections.has(e.section), e.id).toBe(true);
    // And no section is empty.
    for (const s of SECTIONS) expect(ENTRIES.some((e) => e.section === s.id), s.id).toBe(true);
  });

  it('has a control for every stored preference, and no control for one that does not exist', () => {
    const controlled = ENTRIES.filter((e) => e.path).map((e) => e.path as string);
    expect([...controlled].sort()).toEqual(ALL_PATHS.filter((p) => !WITHOUT_A_CONTROL.includes(p)).sort());
    // One control each: a preference in two places could be reset from either and confuse both.
    expect(new Set(controlled).size).toBe(controlled.length);
  });

  it('writes every hint as whole sentences, and no label as one', () => {
    for (const e of ENTRIES) {
      if (e.hint) expect(/[.?!)]$/.test(e.hint), `${e.id}: ${e.hint}`).toBe(true);
      expect(e.label.endsWith('.'), e.id).toBe(false);
    }
  });

  it('keeps the links other screens use', () => {
    for (const id of ['accounts', 'addons', 'servers', 'home', 'about', 'playback', 'languages', 'audio', 'appearance', 'profiles', 'data']) {
      expect(resolveSection(id)).toEqual({ section: id });
    }
    // Sources moved into Playback: the old link lands on what replaced it.
    expect(resolveSection('sources')).toEqual({ section: 'playback', focus: 'sources.autoPlay' });
    expect(entryOf('sources.autoPlay')?.section).toBe('playback');
    // No section named, or one that never existed: the first section.
    expect(resolveSection(undefined).section).toBe(SECTIONS[0].id);
    expect(resolveSection('nonsense').section).toBe(SECTIONS[0].id);
  });

  it('keeps the expert settings under Advanced', () => {
    for (const id of ['sources.regex', 'sources.externalPlayer', 'audio.passthrough', 'playback.hwdec', 'subtitleStyle.outlineColor', 'subtitleStyle.outlineSize', 'subtitleStyle.marginY']) {
      expect(entryOf(id)?.advanced, id).toBe(true);
    }
    for (const id of ['playback.autoPlayNext', 'languages.subtitleMode', 'subtitleStyle.size', 'subtitleStyle.font', 'appearance.hoverPreview', 'audio.delayMs']) {
      expect(entryOf(id)?.advanced, id).toBeFalsy();
    }
  });
});

const changed = (patch: { [S in keyof Settings]?: Partial<Settings[S]> }): Settings => {
  const s = structuredClone(DEFAULT_SETTINGS);
  for (const part of Object.keys(patch) as (keyof Settings)[]) Object.assign(s[part], patch[part]);
  return s;
};

describe('resetting a section', () => {
  it('has nothing to do while everything is at its default', () => {
    expect(planReset(DEFAULT_SETTINGS, DEFAULT_SETTINGS, sectionPaths('playback'))).toBeNull();
  });

  it('puts back only what differs, and only in that section', () => {
    const now = changed({ playback: { autoPlayNext: false, seekStepSec: 30, rememberVolume: false }, sources: { autoPlay: 'regex', regex: '2160p' }, audio: { normalize: true } });
    const plan = planReset(now, DEFAULT_SETTINGS, sectionPaths('playback'))!;
    expect([...plan.changed].sort()).toEqual(['playback.autoPlayNext', 'playback.seekStepSec', 'sources.autoPlay', 'sources.regex']);
    expect(plan.apply).toEqual({ playback: { autoPlayNext: true, seekStepSec: 10 }, sources: { autoPlay: 'binge', regex: '' } });
    // Remembering the volume is on the Audio page, so Playback's reset leaves it alone.
    expect(sectionPaths('audio')).toContain('playback.rememberVolume');
    expect(plan.apply.playback).not.toHaveProperty('rememberVolume');
  });

  it('is undone exactly, keeping a change made in between', () => {
    let now = changed({ languages: { audio: ['ja', 'en'], subtitleMode: 'always' }, subtitleStyle: { font: 'Verdana', outlineColor: '#0B1B3A' } });
    const set = <S extends keyof Settings>(part: S, patch: Partial<Settings[S]>) => {
      now = { ...now, [part]: { ...now[part], ...patch } };
    };
    const before = structuredClone(now);
    const live = now.languages.audio;
    const plan = planReset(now, DEFAULT_SETTINGS, sectionPaths('languages'))!;
    // The plan keeps its own copy of a list, not the one the settings hold.
    expect(plan.undo.languages?.audio).toEqual(live);
    expect(plan.undo.languages?.audio).not.toBe(live);
    applyPatches(set, plan.apply);
    expect(changedPaths(now, DEFAULT_SETTINGS, sectionPaths('languages'))).toEqual([]);
    // Something else is changed before Undo is pressed.
    set('subtitleStyle', { size: 56 });
    applyPatches(set, plan.undo);
    expect(now).toEqual(changed({ ...before, subtitleStyle: { ...before.subtitleStyle, size: 56 } }));
    expect(valueAt(now, 'languages.audio')).toEqual(['ja', 'en']);
  });

  it('counts the advanced settings that are not at their default', () => {
    const now = changed({ playback: { hwdec: 'no', autoPlayNext: false }, sources: { externalPlayer: 'C:\\vlc.exe' } });
    expect(changedPaths(now, DEFAULT_SETTINGS, sectionPaths('playback', 'advanced')).sort()).toEqual(['playback.hwdec', 'sources.externalPlayer']);
  });
});

describe('wording helpers', () => {
  it('counts in the singular and the plural', () => {
    expect(count(1, 'addon')).toBe('1 addon');
    expect(count(0, 'addon')).toBe('0 addons');
    expect(count(2, 'library', 'libraries')).toBe('2 libraries');
  });

  it('says how long ago in words that stay true', () => {
    const now = new Date(2026, 10, 25, 20, 0, 0).getTime();
    expect(ago(null, now)).toBe('never');
    expect(ago(now - 20_000, now)).toBe('just now');
    expect(ago(now - 12 * 60_000, now)).toBe('12 min ago');
    // Earlier today: the time. Another day: the day too, so 9 PM yesterday is not read as tonight.
    expect(ago(now - 3 * 3600_000, now)).toMatch(/^at /);
    expect(ago(now - 26 * 3600_000, now)).toMatch(/ at /);
    expect(ago(now - 26 * 3600_000, now)).not.toMatch(/^at /);
    expect(ago(now - 30 * 86400_000, now)).not.toMatch(/at/);
  });
});
