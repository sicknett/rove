import { useEffect, useRef, useState } from 'react';
import { Lock, Plus } from 'lucide-react';
import { MAX_PROFILES, useProfiles, type Profile } from '../state/profiles';
import { Avatar } from '../components/Avatar';
import { Dialog } from '../ui/controls';
import { ProfileEditor } from './settings/profiles';
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

function PinDialog({ profile, onClose, onOk }: { profile: Profile; onClose: () => void; onOk: () => void }) {
  const [digits, setDigits] = useState('');
  const [wrong, setWrong] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (digits.length !== 4) return;
    if (digits === profile.pin) onOk();
    else {
      setWrong(true);
      const t = window.setTimeout(() => (setDigits(''), setWrong(false)), 600);
      return () => window.clearTimeout(t);
    }
  }, [digits, profile.pin, onOk]);
  return (
    <Dialog open onClose={onClose} title={`PIN for ${profile.name}`} width={380}>
      <div className={`pin ${wrong ? 'is-wrong' : ''}`} onClick={() => input.current?.focus()}>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`pin__dot ${i < digits.length ? 'is-filled' : ''}`} />
        ))}
        <input ref={input} className="pin__input" inputMode="numeric" value={digits} aria-label="PIN" onChange={(e) => setDigits(e.target.value.replace(/\D/g, '').slice(0, 4))} />
      </div>
    </Dialog>
  );
}
