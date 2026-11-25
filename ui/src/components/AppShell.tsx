import { useAmbientPage } from '../screens/home/ambient';
import { useUpdate } from '../lib/update';
import { useSettings } from '../state/settings';
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { CalendarDays, Compass, House, Library, Search, Settings as SettingsIcon } from 'lucide-react';
import { mountedEntries, ScreenContext, useNav, type Entry, type Route } from '../nav/router';
import { useProfiles } from '../state/profiles';
import { useTracker } from '../tracking/sync';
import { Avatar } from './Avatar';
import { TitleBar } from './TitleBar';
import { Home } from '../screens/home/Home';
import { Title } from '../screens/title/Title';
import { Discover, CatalogPage, Search as SearchScreen, Person, CollectionPage } from '../screens/browse';
import { Library as LibraryScreen, Calendar } from '../screens/library';
import { Settings } from '../screens/settings/Settings';
import { CollectionEdit } from '../screens/collectionEdit';
import { ListPage } from '../lists/ListPage';
import markUrl from '../assets/rove-mark.png';

const NAV: { route: Route; label: string; icon: typeof House; key: string }[] = [
  { route: { name: 'home' }, label: 'Home', icon: House, key: 'home' },
  { route: { name: 'search' }, label: 'Search', icon: Search, key: 'search' },
  { route: { name: 'discover' }, label: 'Discover', icon: Compass, key: 'discover' },
  { route: { name: 'library' }, label: 'Library', icon: Library, key: 'library' },
  { route: { name: 'calendar' }, label: 'Calendar', icon: CalendarDays, key: 'calendar' },
];

function Sidebar() {
  const ambient = useAmbientPage((s) => s.color);
  const updateReady = useUpdate((s) => s.status === 'available');
  const current = useNav((s) => s.stack[s.index].route.name);
  const goTab = useNav((s) => s.goTab);
  const profile = useProfiles((s) => s.profiles.find((p) => p.id === s.activeId));
  const signOut = useProfiles((s) => s.signOut);
  const syncState = useTracker((s) => s.state);
  return (
    <nav className="sidebar" aria-label="Main" style={ambient ? ({ '--ambient-page': `color-mix(in srgb, ${ambient} 50%, #0b0c0d)` } as React.CSSProperties) : undefined}>
      <img src={markUrl} alt="ROVE" className="sidebar__mark" draggable={false} />
      <div className="sidebar__items">
        {NAV.map((n) => (
          <button key={n.key} className={`sidebar__item ${current === n.key ? 'is-on' : ''}`} aria-current={current === n.key ? 'page' : undefined} onClick={() => goTab(n.route)}>
            <n.icon size={21} strokeWidth={current === n.key ? 2.2 : 1.8} />
            <span className="sidebar__label">{n.label}</span>
          </button>
        ))}
      </div>
      <div className="sidebar__bottom">
        <button className={`sidebar__item ${current === 'settings' ? 'is-on' : ''}`} onClick={() => goTab({ name: 'settings' })}>
          <SettingsIcon size={21} strokeWidth={current === 'settings' ? 2.2 : 1.8} />
          <span className="sidebar__label">Settings</span>
          {updateReady && <span className="sidebar__dot" title="An update is available" />}
        </button>
        {profile && (
          <button className="sidebar__profile" title={`${profile.name} · switch profile`} onClick={signOut}>
            <Avatar profile={profile} size={34} />
            {(syncState === 'error' || syncState === 'unauthorized') && <span className="sidebar__alert" title="Sync needs attention" />}
          </button>
        )}
      </div>
    </nav>
  );
}

function renderRoute(route: Route) {
  switch (route.name) {
    case 'home':
      return <Home />;
    case 'title':
      return <Title type={route.type} id={route.id} season={route.season} />;
    case 'discover':
      return <Discover type={route.type} catalog={route.catalog} genre={route.genre} />;
    case 'catalog':
      return <CatalogPage addonId={route.addonId} type={route.type} catalogId={route.catalogId} title={route.title} genre={route.genre} />;
    case 'search':
      return <SearchScreen q={route.q} />;
    case 'library':
      return <LibraryScreen tab={route.tab} />;
    case 'calendar':
      return <Calendar />;
    case 'collection':
      return <CollectionPage id={route.id} folder={route.folder} />;
    case 'collection-edit':
      return <CollectionEdit id={route.id} folder={route.folder} />;
    case 'list':
      return <ListPage id={route.id} />;
    case 'person':
      return <Person id={route.id} name={route.label} />;
    case 'settings':
      return <Settings section={route.section} />;
  }
}

/** One screen in its own scroller, kept mounted while it is in recent history. */
const Screen = memo(function Screen({ entry, active, shown }: { entry: Entry; active: boolean; shown: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const toTop = () => ref.current?.scrollTo({ top: 0, behavior: 'smooth' });
    window.addEventListener('rove:scroll-top', toTop);
    return () => window.removeEventListener('rove:scroll-top', toTop);
  }, [active]);

  // New parameters under the same key (a Settings section, a Discover filter) are a new page in
  // the same scroller: it starts at its top. Not the collection editor, where the parameter only
  // opens a folder's dialog over the list.
  const route = useRef(entry.route);
  useLayoutEffect(() => {
    if (route.current === entry.route) return;
    route.current = entry.route;
    if (entry.route.name !== 'collection-edit') ref.current?.scrollTo({ top: 0 });
  }, [entry.route]);

  const screen = useMemo(() => ({ key: entry.key, active: active && shown }), [entry.key, active, shown]);
  return (
    <div ref={ref} className={`screen ${active ? 'is-active' : ''}`} hidden={!active} data-route={entry.route.name}>
      <ScreenContext.Provider value={screen}>{renderRoute(entry.route)}</ScreenContext.Provider>
    </div>
  );
});

export function AppShell({ hidden }: { hidden: boolean }) {
  const navTop = useSettings((s) => s.settings.appearance.navPosition === 'top');
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const stack = useNav((s) => s.stack);
  const index = useNav((s) => s.index);
  const current = stack[index];
  // In key order, not history order: a tab's screen can move within history (goTab), and a
  // scroller that React moves in the page loses its scroll position.
  const mounted = mountedEntries(stack, index).sort((a, b) => a.key - b.key);

  // Mouse back/forward buttons and Alt+arrows.
  useEffect(() => {
    const onMouse = (e: MouseEvent) => {
      // Not under a dialog or sheet: it would be left floating over another screen.
      if (hiddenRef.current || document.querySelector('.overlay')) return;
      if (e.button === 3) (e.preventDefault(), useNav.getState().back());
      if (e.button === 4) (e.preventDefault(), useNav.getState().forward());
    };
    const onKey = (e: KeyboardEvent) => {
      if (hiddenRef.current || document.querySelector('.overlay')) return;
      const tag = (e.target as HTMLElement).tagName;
      if (e.altKey && e.key === 'ArrowLeft') (e.preventDefault(), useNav.getState().back());
      else if (e.altKey && e.key === 'ArrowRight') (e.preventDefault(), useNav.getState().forward());
      else if ((e.ctrlKey && e.key.toLowerCase() === 'k') || (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA')) {
        e.preventDefault();
        useNav.getState().goTab({ name: 'search' });
        // Already on Search, or coming back to it: the box takes the keyboard either way.
        window.dispatchEvent(new CustomEvent('rove:focus-search'));
      } else if (e.key === 'Backspace' && tag !== 'INPUT' && tag !== 'TEXTAREA') useNav.getState().back();
    };
    window.addEventListener('mouseup', onMouse);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mouseup', onMouse);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div className={`shell${navTop ? ' shell--nav-top' : ''}`} hidden={hidden} aria-hidden={hidden}>
      <TitleBar nav />
      <Sidebar />
      <main className="shell__main">
        {mounted.map((e) => (
          <Screen key={e.key} entry={e} active={e.key === current.key} shown={!hidden} />
        ))}
      </main>
    </div>
  );
}
