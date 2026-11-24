import { useRef, useState } from 'react';
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
      <Group title="Profiles" note="Each profile has its own Home layout, history, PublicMetaDB account and player preferences. Addons are shared.">
        {profiles.map((p) => (
          <div key={p.id} className="profile-row">
            <Avatar profile={p} size={40} />
            <div className="profile-row__text">
              <span className="profile-row__name">
                {p.name} {p.id === activeId && <span className="tag">This profile</span>}
              </span>
              <span className="profile-row__sub">{[p.kids ? 'Kids' : null, p.pin ? 'PIN set' : null].filter(Boolean).join(' · ') || 'No PIN'}</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setEditing(p)}>
              Edit
            </Button>
          </div>
        ))}
        {profiles.length < MAX_PROFILES && (
          <div className="s-row s-row--actions">
            <Button variant="secondary" icon={<Plus size={16} />} onClick={() => setEditing('new')}>
              Add a profile
            </Button>
          </div>
        )}
      </Group>
      <Group title="Starting ROVE">
        <SettingRow label="Open the last profile" hint="Skips the profile picker unless that profile has a PIN">
          <Switch checked={autoOpenLast} onChange={setAutoOpenLast} label="Open the last profile" />
        </SettingRow>
      </Group>
      {editing && <ProfileEditor profile={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

export function ProfileEditor({ profile, onClose }: { profile: Profile | null; onClose: () => void }) {
  const { create, update, remove, profiles } = useProfiles.getState();
  const [name, setName] = useState(profile?.name ?? '');
  const [color, setColor] = useState(profile?.color ?? AVATAR_COLORS[profiles.length % AVATAR_COLORS.length]);
  const [pin, setPin] = useState(profile?.pin ?? '');
  const [kids, setKids] = useState(profile?.kids ?? false);
  const [image, setImage] = useState<string | undefined>(profile?.image);
  const photoInput = useRef<HTMLInputElement>(null);
  const pickPhoto = async (f: File) => {
    try {
      setImage(await squarePhoto(f));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'That image could not be used.');
    }
  };
  const pinOk = pin === '' || /^\d{4}$/.test(pin);
  const save = () => {
    if (!name.trim() || !pinOk) return;
    const data = { name: name.trim(), color, pin: pin || undefined, kids, image };
    if (profile) update(profile.id, data);
    else create(data);
    onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={profile ? `Edit ${profile.name}` : 'New profile'}
      width={480}
      footer={
        <>
          {profile && profiles.length > 1 && (
            <Button variant="danger" icon={<Trash2 size={16} />} onClick={() => (remove(profile.id), onClose())}>
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
        <TextField label="PIN (optional)" value={pin} onChange={(v) => setPin(v.replace(/\D/g, '').slice(0, 4))} secret error={pinOk ? null : 'Four digits'} hint="Asked when opening this profile" trailing={<Lock size={15} className="field__icon" />} />
        <label className="check-row">
          <Switch checked={kids} onChange={setKids} label="Kids profile" />
          <span>Kids profile: hides addon content marked for adults</span>
        </label>
      </div>
    </Dialog>
  );
}
