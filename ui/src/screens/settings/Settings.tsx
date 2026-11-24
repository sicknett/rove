import { useState } from 'react';
import { CircleUser, Puzzle, LayoutGrid, PlayCircle, ListVideo, Languages, Volume2, Palette, Users, Database, Info, Server } from 'lucide-react';
import { useNav } from '../../nav/router';
import { AccountsSection } from './accounts';
import { AddonsSection } from './addons';
import { HomeSection } from './home';
import { PlaybackSection, SourcesSection, LanguagesSection, AudioSection, AppearanceSection } from './preferences';
import { ProfilesSection } from './profiles';
import { ServersSection } from './servers';
import { DataSection, AboutSection } from './data';

const SECTIONS = [
  { id: 'accounts', label: 'Accounts', icon: CircleUser, render: () => <AccountsSection /> },
  { id: 'addons', label: 'Addons', icon: Puzzle, render: () => <AddonsSection /> },
  { id: 'servers', label: 'Media servers', icon: Server, render: () => <ServersSection /> },
  { id: 'home', label: 'Home layout', icon: LayoutGrid, render: () => <HomeSection /> },
  { id: 'playback', label: 'Playback', icon: PlayCircle, render: () => <PlaybackSection /> },
  { id: 'sources', label: 'Sources', icon: ListVideo, render: () => <SourcesSection /> },
  { id: 'languages', label: 'Languages & subtitles', icon: Languages, render: () => <LanguagesSection /> },
  { id: 'audio', label: 'Audio', icon: Volume2, render: () => <AudioSection /> },
  { id: 'appearance', label: 'Appearance', icon: Palette, render: () => <AppearanceSection /> },
  { id: 'profiles', label: 'Profiles', icon: Users, render: () => <ProfilesSection /> },
  { id: 'data', label: 'Data', icon: Database, render: () => <DataSection /> },
  { id: 'about', label: 'About', icon: Info, render: () => <AboutSection /> },
] as const;

export function Settings({ section }: { section?: string }) {
  const replace = useNav((s) => s.replace);
  const [hover, setHover] = useState<string | null>(null);
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  return (
    <div className="settings">
      <nav className="settings__nav" aria-label="Settings sections">
        <h1 className="page-title settings__title">Settings</h1>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`settings__link ${s.id === current.id ? 'is-on' : ''} ${hover === s.id ? 'is-hover' : ''}`}
            aria-current={s.id === current.id ? 'page' : undefined}
            onClick={() => replace({ name: 'settings', section: s.id })}
            onPointerEnter={() => setHover(s.id)}
            onPointerLeave={() => setHover(null)}
          >
            <s.icon size={18} />
            {s.label}
          </button>
        ))}
      </nav>
      <div className="settings__body" key={current.id}>
        <h2 className="settings__heading">{current.label}</h2>
        {current.render()}
      </div>
    </div>
  );
}
