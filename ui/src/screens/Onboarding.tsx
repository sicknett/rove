import { useRef, useState } from 'react';
import { ArrowRight, Check, FileUp, Plus } from 'lucide-react';
import { useAddons } from '../addons/store';
import { ReplaceAddonDialog, useAddonInstall } from './settings/addons';
import { readBackup, restoreBackup } from '../lib/backup';
import { Button, TextField } from '../ui/controls';
import { Img } from '../ui/Img';
import { toast } from '../ui/toast';
import logoUrl from '../assets/rove-logo.png';
import wallpaperUrl from '../assets/wallpaper.png';

/** First start with no addons: add addon links, or restore a ROVE backup from another PC. */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const [link, setLink] = useState('');
  const adding = useAddonInstall(() => setLink(''));
  const addons = useAddons((s) => s.addons);
  const file = useRef<HTMLInputElement>(null);

  const restore = async (f: File) => {
    try {
      const summary = await restoreBackup(readBackup(await f.text()));
      toast.success(`Restored ${summary.addons} addons and ${summary.profiles} profile${summary.profiles === 1 ? '' : 's'}`);
      window.setTimeout(() => location.reload(), 600);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'That backup could not be read.');
    }
  };

  return (
    <main className="onboarding">
      <div className="picker__bg" style={{ backgroundImage: `url(${wallpaperUrl})` }} />
      <div className="picker__shade" />
      <div className="onboarding__card">
        <img src={logoUrl} alt="ROVE" className="onboarding__logo" draggable={false} />
        <h1 className="onboarding__title">Bring your addons</h1>
        <p className="onboarding__lede">
          ROVE plays from addons you choose: a metadata addon for catalogs and details (such as AIOMetadata or Cinemeta) and a stream addon for sources (such as AIOStreams). Paste each one's manifest link.
        </p>

        <div className="onboarding__option onboarding__option--stack">
          <div className="inline-form">
            <TextField value={link} onChange={setLink} placeholder="https://…/manifest.json" error={adding.error} onKeyDown={(e) => e.key === 'Enter' && void adding.install(link)} autoFocus />
            <Button variant="primary" icon={<Plus size={16} />} busy={adding.busy} disabled={!link.trim()} onClick={() => void adding.install(link)}>
              Add
            </Button>
          </div>
          {addons.length > 0 && (
            <ul className="onboarding__addons">
              {addons.map((a) => (
                <li key={a.url}>
                  <Img src={a.manifest.logo} alt="" className="onboarding__addon-logo" fallback={<span className="onboarding__addon-logo onboarding__addon-mono">{a.manifest.name[0]}</span>} />
                  <span>{a.manifest.name}</span>
                  <Check size={15} className="onboarding__addon-check" />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="onboarding__option">
          <div>
            <h2 className="onboarding__option-title">Setting up another PC?</h2>
            <p className="onboarding__option-text">Restore a ROVE backup (Settings → Data → Back up) to get the same addons, profiles and layout.</p>
          </div>
          <Button variant="secondary" icon={<FileUp size={16} />} onClick={() => file.current?.click()}>
            Restore
          </Button>
          <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && void restore(e.target.files[0])} />
        </div>

        <div className="onboarding__foot">
          <span className="onboarding__count">{addons.length ? `${addons.length} addon${addons.length > 1 ? 's' : ''} added` : 'You can also add addons later in Settings'}</span>
          <Button variant={addons.length ? 'primary' : 'ghost'} icon={<ArrowRight size={16} />} onClick={onDone}>
            {addons.length ? 'Continue' : 'Skip for now'}
          </Button>
        </div>
      </div>
      <ReplaceAddonDialog state={adding} />
    </main>
  );
}
