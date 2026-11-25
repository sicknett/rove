import { useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, Lock, Plus, Trash2 } from 'lucide-react';
import { toast } from '../../ui/toast';
import { AVATAR_COLORS, MAX_PROFILES, useProfiles, type Profile } from '../../state/profiles';
import { Button, Dialog, Switch, TextField } from '../../ui/controls';
import { Avatar, squarePhoto } from '../../components/Avatar';
import { Group, SettingRow } from './parts';

export function ProfilesSection() {
  const { profiles, activeId, autoOpenLast, setAutoOpenLast } = useProfiles();
  const [editing, setEditing] = useState<Profile | 'new' | null>(null);
  return (
    <>
      <Group
        id="profiles.list"
        note="Each profile has its own Home layout, watch history, tracker sign-in, collections, and playback, subtitle, audio and appearance settings. Addons, media servers, the AI assistant and the TMDB key are shared by all of them."
      >
        {profiles.map((p) => (
          <div key={p.id} className="profile-row">
            <Avatar profile={p} size={40} />
            <div className="profile-row__text">
              <span className="profile-row__name">
                {p.name} {p.id === activeId && <span className="tag">This profile</span>}
              </span>
              <span className="profile-row__sub">{[p.kids ? 'Kids profile' : null, p.pin ? 'Locked with a PIN' : 'No PIN'].filter(Boolean).join(' · ')}</span>
            </div>
            <Button variant="ghost" size="sm" aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)}>
              Edit
            </Button>
          </div>
        ))}
        <div className="s-row s-row--actions">
          {profiles.length >= MAX_PROFILES && <span className="s-row__hint">{MAX_PROFILES} profiles is the most ROVE keeps. Delete one to add another.</span>}
          <Button variant="secondary" icon={<Plus size={16} />} disabled={profiles.length >= MAX_PROFILES} onClick={() => setEditing('new')}>
            Add a profile
          </Button>
        </div>
      </Group>
      <Group title="Starting ROVE">
        <SettingRow id="profiles.autoOpenLast">
          <Switch checked={autoOpenLast} onChange={setAutoOpenLast} label="Open the last profile when ROVE starts" />
        </SettingRow>
      </Group>
      {editing && <ProfileEditor profile={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

/** Asks for a profile's PIN: to open the profile, or before it can be edited. */
export function PinDialog({ profile, onClose, onOk }: { profile: Profile; onClose: () => void; onOk: () => void }) {
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

export function ProfileEditor({ profile, onClose }: { profile: Profile | null; onClose: () => void }) {
  const { create, update, remove, profiles } = useProfiles.getState();
  const hasPin = !!profile?.pin;
  // A profile behind a PIN is changed (or unlocked, or deleted) only by someone who knows the PIN.
  const [unlocked, setUnlocked] = useState(!hasPin);
  const [name, setName] = useState(profile?.name ?? '');
  const [color, setColor] = useState(profile?.color ?? AVATAR_COLORS[profiles.length % AVATAR_COLORS.length]);
  // The saved PIN never goes into the field, which can be shown: the field takes a new one, and
  // left empty keeps what is saved.
  const [pin, setPin] = useState('');
  const [removePin, setRemovePin] = useState(false);
  const [kids, setKids] = useState(profile?.kids ?? false);
  const [image, setImage] = useState<string | undefined>(profile?.image);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  const pickPhoto = async (f: File) => {
    try {
      setImage(await squarePhoto(f));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'That image could not be used.');
    }
  };
  const pinOk = removePin || pin === '' || /^\d{4}$/.test(pin);
  const save = () => {
    if (!name.trim() || !pinOk) return;
    const data = { name: name.trim(), color, pin: removePin ? undefined : pin || profile?.pin, kids, image };
    if (profile) update(profile.id, data);
    else create(data);
    onClose();
  };

  if (profile && !unlocked) return <PinDialog profile={profile} onClose={onClose} onOk={() => setUnlocked(true)} />;

  if (profile && confirmDelete)
    return (
      <Dialog
        open
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${profile.name}?`}
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                remove(profile.id);
                onClose();
                toast.success(`${profile.name} deleted`);
              }}
            >
              Delete profile
            </Button>
          </>
        }
      >
        <p className="dialog__text">Its settings, Home layout, collections, watch history and tracker sign-in are removed from this PC. This cannot be undone.</p>
      </Dialog>
    );

  return (
    <Dialog
      open
      onClose={onClose}
      title={profile ? `Edit ${profile.name}` : 'New profile'}
      width={480}
      footer={
        <>
          {profile && profiles.length > 1 && (
            <Button variant="danger" icon={<Trash2 size={16} />} onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          )}
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim() || !pinOk} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <div className="profile-editor__preview">
          <button className="profile-editor__photo" onClick={() => photoInput.current?.click()} aria-label="Choose a photo">
            <Avatar profile={{ id: 'x', name: name || '?', color, image, createdAt: 0 }} size={88} />
            <span className="profile-editor__photo-edit">
              <Camera size={16} />
            </span>
          </button>
          <div className="profile-editor__photo-actions">
            <Button variant="secondary" size="sm" icon={<ImagePlus size={15} />} onClick={() => photoInput.current?.click()}>
              {image ? 'Change photo' : 'Upload photo'}
            </Button>
            {image && (
              <Button variant="ghost" size="sm" onClick={() => setImage(undefined)}>
                Remove photo
              </Button>
            )}
          </div>
          <input ref={photoInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => (e.target.files?.[0] && void pickPhoto(e.target.files[0]), (e.target.value = ''))} />
        </div>
        <TextField label="Name" value={name} onChange={setName} maxLength={24} data-autofocus onKeyDown={(e) => e.key === 'Enter' && save()} />
        <div className="field">
          <span className="field__label">Colour</span>
          <div className="swatches">
            {AVATAR_COLORS.map((c) => (
              <button key={c} className={`swatch swatch--lg ${color === c ? 'is-on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
        <TextField
          label={hasPin ? 'New PIN (optional)' : 'PIN (optional)'}
          value={removePin ? '' : pin}
          onChange={(v) => setPin(v.replace(/\D/g, '').slice(0, 4))}
          secret
          disabled={removePin}
          error={pinOk ? null : 'Four digits'}
          hint={hasPin ? 'A PIN is set. Leave this empty to keep it.' : 'Asked when opening this profile'}
          trailing={<Lock size={15} className="field__icon" />}
        />
        {hasPin && (
          <label className="check-row">
            <Switch checked={removePin} onChange={setRemovePin} label="Remove the PIN" />
            <span>Remove the PIN</span>
          </label>
        )}
        <label className="check-row">
          <Switch checked={kids} onChange={setKids} label="Kids profile" />
          <span>Kids profile: hides addon content marked for adults</span>
        </label>
      </div>
    </Dialog>
  );
}
