import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { mpv, send, subscribe } from './bridge';
import { useAddons } from './addons/store';
import { flushAll } from './state/flushAll';
import { AppShell } from './components/AppShell';
import { TitleBar } from './components/TitleBar';
import { docs } from './lib/native';
import { loadIdMap } from './tracking/idmap';
import { startSync, useTracker } from './tracking/sync';
import { Player } from './player/Player';
import { SourcesSheet } from './player/SourcesSheet';
import { FindingOverlay, ResumeDialog } from './player/PlaybackDialogs';
import { loadLinks, startStream, usePlayback } from './player/session';
import { applyPlayerSettings, loadTrackMemory } from './player/prefs';
import { onOpenRequest, startListening } from './player/store';
import { titleFromUrl } from './format';
import { setPip } from './player/pip';
import { seedDefaultCollections, useCollections } from './state/collections';
import { useHistory } from './state/history';
import { useHomeLayout } from './state/homeLayout';
import { useKeys } from './state/keys';
import { useProfiles } from './state/profiles';
import { useSettings } from './state/settings';
import { useNav } from './nav/router';
import { ProfilePicker } from './screens/ProfilePicker';
import { Onboarding } from './screens/Onboarding';
import { ContextMenuHost } from './ui/contextmenu';
import { ToastViewport } from './ui/toast';
import logoUrl from './assets/rove-logo.png';
import { useServers } from './servers/store';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, refetchOnReconnect: true } },
});


/** Loads everything that belongs to the active profile. */
async function loadProfile() {
  await Promise.all([
    useSettings.getState().load(),
    useHistory.getState().load(),
    useHomeLayout.getState().load(),
    useCollections.getState().load(),
    useTracker.getState().load(),
    loadLinks(),
    loadTrackMemory(),
  ]);
}

function Splash() {
  return (
    <div className="splash">
      <img src={logoUrl} alt="ROVE" className="splash__logo" />
    </div>
  );
}

export function App() {
  const profilesLoaded = useProfiles((s) => s.loaded);
  const activeId = useProfiles((s) => s.activeId);
  const session = usePlayback((s) => s.session);
  const addonsLoaded = useAddons((s) => s.loaded);
  const addonCount = useAddons((s) => s.addons.length);
  const appearance = useSettings((s) => s.settings.appearance);
  const [profileReady, setProfileReady] = useState<string | null>(null);
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  // Decided once: setup shows on a first start with no addons, and stays until Continue.
  const [showSetup, setShowSetup] = useState<boolean | null>(null);
  useEffect(() => {
    if (showSetup === null && onboarded !== null && addonsLoaded) setShowSetup(!onboarded && addonCount === 0);
  }, [showSetup, onboarded, addonsLoaded, addonCount]);

  // App-wide: the bridge, profiles, addons, keys.
  useEffect(() => {
    const stop = startListening();
    const unsubClose = subscribe((m) => {
      if ((m as { t: string }).t === 'closing') void flushAll().finally(() => send({ t: 'close-ready' }));
    });
    send({ t: 'ready' });
    void useProfiles.getState().load();
    void useAddons.getState().load();
    void useServers.getState().load();
    void useKeys.getState().load();
    void loadIdMap();
    void docs.read<boolean>('onboarded').then((v) => setOnboarded(!!v));
    // `rove.exe --play <link>`: play a bare link (used for checks and quick tests).
    const offOpen = onOpenRequest((e) => {
      const name = e.title ?? titleFromUrl(e.url);
      startStream({ type: 'movie', metaId: `link:${e.url}`, videoId: e.url, name }, { url: e.url, addonId: 'link', addonName: 'Link', rank: 0 }, 0);
    });
    const volume = Number(localStorage.getItem('rove.volume'));
    if (volume > 0) mpv.set('volume', volume);
    return () => {
      stop();
      unsubClose();
      offOpen();
    };
  }, []);

  // Per profile: load, then keep tracker sync running while it is active.
  useEffect(() => {
    if (!activeId) return;
    let alive = true;
    let stopSync: (() => void) | null = null;
    setProfileReady(null);
    void loadProfile().then(() => {
      if (!alive) return;
      applyPlayerSettings();
      void seedDefaultCollections();
      stopSync = startSync();
      useNav.setState({ stack: [{ key: Date.now(), route: { name: 'home' } }], index: 0 });
      setProfileReady(activeId);
    });
    return () => {
      alive = false;
      stopSync?.();
      void flushAll();
    };
  }, [activeId]);

  // While video plays, the page is see-through so mpv's picture shows beneath it.
  useEffect(() => {
    document.documentElement.classList.toggle('is-playing', !!session);
    // The page is see-through (and the video window shown) only while something plays.
    send({ t: 'video', visible: !!session });
    if (!session) setPip(false);
  }, [session]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.accent = appearance.accent;
    root.dataset.cards = appearance.cardSize;
    root.classList.toggle('reduce-motion', appearance.reduceMotion);
  }, [appearance]);

  const finishOnboarding = () => {
    setOnboarded(true);
    setShowSetup(false);
    void docs.write('onboarded', true);
  };

  let body: React.ReactNode;
  // Screens before the main one draw no title bar of their own; this one makes them movable.
  const bareTitleBar = <TitleBar />;
  if (!profilesLoaded) body = <Splash />;
  else if (!activeId) body = <ProfilePicker />;
  else if (profileReady !== activeId || !addonsLoaded || showSetup === null) body = <Splash />;
  else if (showSetup) body = <Onboarding onDone={finishOnboarding} />;
  else
    body = (
      <>
        <AppShell hidden={!!session} />
        <SourcesSheet />
        <ResumeDialog />
        <FindingOverlay />
      </>
    );

  return (
    <QueryClientProvider client={queryClient}>
      <div className="app">
        {(!profilesLoaded || !activeId || profileReady !== activeId || !addonsLoaded || showSetup !== false) && !session && bareTitleBar}
        {body}
        {session && <Player />}
      </div>
      <ContextMenuHost />
      <ToastViewport />
    </QueryClientProvider>
  );
}

