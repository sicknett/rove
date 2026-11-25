// Settings: sections grouped by what a person is trying to do, a search over every control,
// and under each heading what is in effect right now.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Captions, CircleUser, Database, Info, LayoutGrid, Palette, PlayCircle, Puzzle, RotateCcw, Search, Server, Users, Volume2, X, type LucideIcon } from 'lucide-react';
import { useNav, useScreen } from '../../nav/router';
import { useHomeLayout } from '../../state/homeLayout';
import { useProfiles } from '../../state/profiles';
import { DEFAULT_SETTINGS, settingsNow, useSettings } from '../../state/settings';
import { Button } from '../../ui/controls';
import { toast } from '../../ui/toast';
import { AboutSection } from './about';
import { AccountsSection } from './accounts';
import { AddonsSection } from './addons';
import { AppearanceSection } from './appearance';
import { AudioSection } from './audio';
import { entryOf, resolveSection, SECTION_GROUPS, sectionInfo, sectionPaths, type SectionId, type SectionInfo } from './catalog';
import { DataSection } from './data';
import { count } from './format';
import { HomeSection } from './home';
import { SettingsNavContext, type FocusTarget } from './parts';
import { PlaybackSection } from './playback';
import { ProfilesSection } from './profiles';
import { applyPatches, changedPaths, planReset } from './reset';
import { searchSettings, type SearchResult } from './search';
import { ServersSection } from './servers';
import { useSectionStatuses, type SectionStatus } from './status';
import { SubtitlesSection } from './subtitles';

const PAGES: Record<SectionId, { icon: LucideIcon; render: () => React.ReactNode }> = {
  playback: { icon: PlayCircle, render: () => <PlaybackSection /> },
  languages: { icon: Captions, render: () => <SubtitlesSection /> },
  audio: { icon: Volume2, render: () => <AudioSection /> },
  home: { icon: LayoutGrid, render: () => <HomeSection /> },
  appearance: { icon: Palette, render: () => <AppearanceSection /> },
  addons: { icon: Puzzle, render: () => <AddonsSection /> },
  servers: { icon: Server, render: () => <ServersSection /> },
  accounts: { icon: CircleUser, render: () => <AccountsSection /> },
  profiles: { icon: Users, render: () => <ProfilesSection /> },
  data: { icon: Database, render: () => <DataSection /> },
  about: { icon: Info, render: () => <AboutSection /> },
};

/** How long a control that was jumped to stays marked. */
const FOUND_MS = 2600;

export function Settings({ section }: { section?: string }) {
  const replace = useNav((s) => s.replace);
  const { active } = useScreen();
  const resolved = resolveSection(section);
  const current = sectionInfo(resolved.section);
  const statuses = useSectionStatuses();
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<FocusTarget | null>(null);
  const results = useMemo(() => searchSettings(query), [query]);
  const searching = query.trim().length > 0;
  const page = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const resultsId = useId();

  // A link to a section that has moved lands on the control that replaced it.
  const [routed, setRouted] = useState<string | undefined>(undefined);
  if (section !== routed) {
    setRouted(section);
    if (resolved.focus) setTarget({ id: resolved.focus });
    // Arriving somewhere else forgets a control jumped to earlier, or coming back would jump to it again.
    else if (target && entryOf(target.id)?.section !== resolved.section) setTarget(null);
  }

  const open = useCallback(
    (id: SectionId) => {
      setQuery('');
      setTarget(null);
      replace({ name: 'settings', section: id });
    },
    [replace],
  );

  const go = useCallback(
    (id: string) => {
      const wanted = entryOf(id);
      if (!wanted) return;
      setQuery('');
      if (wanted.section !== current.id) replace({ name: 'settings', section: wanted.section });
      setTarget({ id });
    },
    [current.id, replace],
  );
  const nav = useMemo(() => ({ target, go }), [target, go]);

  const pick = (r: SearchResult) => (r.entry ? go(r.entry.id) : open(r.section));

  // Bring the asked-for control into view and mark it for a moment. The keyboard lands on its
  // row, not on its control: Enter held a moment too long must not press a button.
  useEffect(() => {
    if (!target || searching) return;
    const el = page.current?.querySelector<HTMLElement>(`[data-setting="${target.id}"]`);
    if (!el) return;
    const calm = document.documentElement.classList.contains('reduce-motion') || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
    el.tabIndex = -1;
    el.focus({ preventScroll: true });
    el.setAttribute('data-found', '');
    const timer = window.setTimeout(() => el.removeAttribute('data-found'), FOUND_MS);
    return () => {
      window.clearTimeout(timer);
      el.removeAttribute('data-found');
    };
  }, [target, current.id, searching]);

  // Ctrl+F searches Settings while Settings is the screen in front.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'f' || document.querySelector('.overlay')) return;
      e.preventDefault();
      box.current?.focus();
      box.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  const resultButtons = () => [...(list.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
  const onBoxKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' && results.length) {
      e.preventDefault();
      resultButtons()[0]?.focus();
    } else if (e.key === 'Enter' && results.length) {
      e.preventDefault();
      pick(results[0]);
    } else if (e.key === 'Escape' && query) {
      e.preventDefault();
      setQuery('');
    }
  };
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Escape') return;
    e.preventDefault();
    if (e.key === 'Escape') {
      setQuery('');
      box.current?.focus();
      return;
    }
    const buttons = resultButtons();
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowUp' && i <= 0) box.current?.focus();
    else buttons[Math.min(buttons.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))]?.focus();
  };

  return (
    <div className="settings">
      <nav className="settings__nav" aria-label="Settings sections">
        <h1 className="page-title settings__title">Settings</h1>
        <div className="settings__search" role="search">
          <Search size={16} className="settings__search-icon" aria-hidden />
          <input
            ref={box}
            className="settings__search-input"
            type="text"
            value={query}
            placeholder="Search settings"
            aria-label="Search settings"
            aria-controls={resultsId}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setQuery(e.target.value);
              // A new search forgets the last control jumped to, or clearing the box would jump back to it.
              setTarget(null);
            }}
            onKeyDown={onBoxKey}
          />
          {query && (
            <button
              type="button"
              className="settings__search-clear"
              aria-label="Clear the search"
              onClick={() => {
                setQuery('');
                box.current?.focus();
              }}
            >
              <X size={14} />
            </button>
          )}
        </div>
        {SECTION_GROUPS.map((g) => (
          <div key={g.label} className="settings__group" role="group" aria-label={g.label}>
            <span className="settings__group-label" aria-hidden>
              {g.label}
            </span>
            {g.sections.map((s) => {
              const Icon = PAGES[s.id].icon;
              const on = !searching && s.id === current.id;
              const attention = statuses[s.id]?.attention;
              return (
                <button key={s.id} type="button" className={`settings__link ${on ? 'is-on' : ''}`} aria-current={on ? 'page' : undefined} onClick={() => open(s.id)}>
                  <Icon size={18} />
                  <span className="settings__link-label">{s.label}</span>
                  {attention && <span className="settings__dot" role="img" aria-label={attention} title={attention} />}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <SettingsNavContext.Provider value={nav}>
        <div className="settings__body">
          <div id={resultsId} className="settings__page" hidden={!searching}>
            {searching && (
              <>
                <header className="settings__head">
                  <div className="settings__head-text">
                    <h2 className="settings__heading">{results.length ? `Settings for “${query.trim()}”` : `Nothing in Settings fits “${query.trim()}”`}</h2>
                    <p className="settings__status" role="status">
                      {results.length ? `${count(results.length, 'match', 'matches')}. Enter opens the first one.` : 'Try one plain word, such as subtitles, trailer, volume or backup.'}
                    </p>
                  </div>
                </header>
                <ul ref={list} className="s-results" onKeyDown={onListKey}>
                  {results.map((r) => (
                    <li key={r.id}>
                      <button type="button" className="s-result" onClick={() => pick(r)}>
                        <span className="s-result__label">{r.label}</span>
                        <span className="s-result__place">{r.entry ? [r.sectionLabel, r.advanced ? 'Advanced' : null, r.group || null].filter(Boolean).join(' › ') : 'Section'}</span>
                        {r.hint && <span className="s-result__hint">{r.hint}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          {/* Kept while a search is typed: a key half pasted into a page is still there afterwards. */}
          <div ref={page} key={current.id} className="settings__page" hidden={searching}>
            <SectionHead info={current} status={statuses[current.id]} />
            {PAGES[current.id].render()}
          </div>
        </div>
      </SettingsNavContext.Provider>
    </div>
  );
}

function SectionHead({ info, status }: { info: SectionInfo; status?: SectionStatus }) {
  const profiles = useProfiles((s) => s.profiles);
  const activeId = useProfiles((s) => s.activeId);
  const openProfile = profiles.find((p) => p.id === activeId);
  // Only worth saying once there is more than one profile to tell apart.
  const scope = profiles.length < 2 ? null : info.scope === 'profile' ? `These are ${openProfile?.name ?? 'this profile'}’s own; other profiles keep theirs.` : info.scope === 'shared' ? 'Shared by every profile.' : null;
  return (
    <header className="settings__head">
      <div className="settings__head-text">
        <h2 className="settings__heading">{info.label}</h2>
        {(status || scope) && (
          <p className="settings__status">
            {status?.text}
            {status && scope && <br />}
            {scope}
          </p>
        )}
      </div>
      <ResetSection info={info} />
    </header>
  );
}

/** Puts a section's preferences back to their defaults, with a way to take that back. */
function ResetSection({ info }: { info: SectionInfo }) {
  const paths = useMemo(() => sectionPaths(info.id), [info.id]);
  const settings = useSettings((s) => s.settings);
  const changed = useMemo(() => changedPaths(settings, DEFAULT_SETTINGS, paths), [settings, paths]);
  // Home's banner is switched in two places that are kept the same (see home.tsx).
  const bannerOffInLayout = useHomeLayout((s) => info.id === 'home' && !s.heroEnabled);
  const n = changed.length + (bannerOffInLayout && !changed.includes('appearance.heroEnabled') ? 1 : 0);
  if (!paths.length) return null;
  if (!n) return <span className="settings__defaults">Everything here is at its default</span>;

  const reset = () => {
    const plan = planReset(settingsNow(), DEFAULT_SETTINGS, paths);
    if (plan) applyPatches(useSettings.getState().set, plan.apply);
    if (bannerOffInLayout) useHomeLayout.getState().setHeroEnabled(true);
    toast.info(`${info.label}: ${count(n, 'setting')} back to ${n === 1 ? 'its default' : 'their defaults'}`, {
      label: 'Undo',
      run: () => {
        if (plan) applyPatches(useSettings.getState().set, plan.undo);
        if (bannerOffInLayout) useHomeLayout.getState().setHeroEnabled(false);
      },
    });
  };
  return (
    <Button variant="ghost" size="sm" icon={<RotateCcw size={15} />} onClick={reset} title={`${count(n, 'setting')} here ${n === 1 ? 'is' : 'are'} not at the default`}>
      Reset this section
    </Button>
  );
}
