import { useState } from 'react';
import { Lock, Plus } from 'lucide-react';
import { MAX_PROFILES, useProfiles, type Profile } from '../state/profiles';
import { Avatar } from '../components/Avatar';
import { PinDialog, ProfileEditor } from './settings/profiles';
import logoUrl from '../assets/rove-logo.png';
import wallpaperUrl from '../assets/wallpaper.png';

export function ProfilePicker() {
  const profiles = useProfiles((s) => s.profiles);
  const activate = useProfiles((s) => s.activate);
  const [pinFor, setPinFor] = useState<Profile | null>(null);
  const [adding, setAdding] = useState(false);

  const open = (p: Profile) => (p.pin ? setPinFor(p) : activate(p.id));

  return (
    <main className="picker">
      <div className="picker__bg" style={{ backgroundImage: `url(${wallpaperUrl})` }} />
      <div className="picker__shade" />
      <div className="picker__content">
        <img src={logoUrl} alt="ROVE" className="picker__logo" draggable={false} />
        <h1 className="picker__title">Who's watching?</h1>
        <div className="picker__list">
          {profiles.map((p) => (
            <button key={p.id} className="picker__profile" onClick={() => open(p)}>
              <Avatar profile={p} size={112} />
              <span className="picker__name">
                {p.name}
                {p.pin && <Lock size={13} />}
              </span>
            </button>
          ))}
          {profiles.length < MAX_PROFILES && (
            <button className="picker__profile picker__profile--add" onClick={() => setAdding(true)}>
              <span className="picker__add">
                <Plus size={40} />
              </span>
              <span className="picker__name">Add profile</span>
            </button>
          )}
        </div>
      </div>
      {pinFor && <PinDialog profile={pinFor} onClose={() => setPinFor(null)} onOk={() => activate(pinFor.id)} />}
      {adding && <ProfileEditor profile={null} onClose={() => setAdding(false)} />}
    </main>
  );
}
