import { useRef, useState } from 'react';
import { Download, FolderOpen, Trash2, Upload } from 'lucide-react';
import { readBackup, restoreBackup, saveBackup } from '../../lib/backup';
import { useQueryClient } from '@tanstack/react-query';
import { invalidate } from '../../lib/http';
import { send } from '../../bridge';
import { useHistory } from '../../state/history';
import { Button, Dialog, Switch } from '../../ui/controls';
import { toast } from '../../ui/toast';
import { Group, SettingRow } from './parts';
import markUrl from '../../assets/rove-mark.png';

export function DataSection() {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [withKeys, setWithKeys] = useState(false);
  const [saving, setSaving] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const restore = async (f: File) => {
    try {
      const summary = await restoreBackup(readBackup(await f.text()));
      toast.success(`Restored ${summary.addons} addons and ${summary.profiles} profile${summary.profiles === 1 ? '' : 's'}. Reloading…`);
      window.setTimeout(() => location.reload(), 900);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'That backup could not be read.');
    }
  };
  return (
    <>
      <Group title="Back up and move to another PC" note="A backup holds your addons, profiles, and each profile's settings, Home layout, collections and track choices. Watch history is not in it: PublicMetaDB brings that to every device.">
        <SettingRow label="Include API keys" hint="Your PublicMetaDB and TMDB keys. Keep a backup with keys private, like a password.">
          <Switch checked={withKeys} onChange={setWithKeys} label="Include API keys" />
        </SettingRow>
        <SettingRow label="Back up" hint="Saves a .json file you can copy to another PC">
          <Button
            variant="secondary"
            icon={<Download size={16} />}
            busy={saving}
            onClick={async () => {
              setSaving(true);
              try {
                if (await saveBackup(withKeys)) toast.success('Backup saved');
              } catch {
                toast.error('The backup could not be saved.');
              } finally {
                setSaving(false);
              }
            }}
          >
            Back up
          </Button>
        </SettingRow>
        <SettingRow label="Restore" hint="Replaces this PC's addons, profiles and settings with the backup's">
          <Button variant="secondary" icon={<Upload size={16} />} onClick={() => file.current?.click()}>
            Restore…
          </Button>
          <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && void restore(e.target.files[0])} />
        </SettingRow>
      </Group>
      <Group title="Storage">
        <SettingRow label="Clear cached catalogs and metadata" hint="Everything reloads from your addons; history and settings stay">
          <Button
            variant="secondary"
            onClick={() => {
              qc.clear();
              invalidate('');
              toast.success('Cache cleared');
            }}
          >
            Clear cache
          </Button>
        </SettingRow>
        <SettingRow label="Logs" hint="For reporting a problem: playback events and errors, never addon links or keys">
          <Button variant="ghost" icon={<FolderOpen size={16} />} onClick={() => send({ t: 'open-folder', which: 'logs' })}>
            Open folder
          </Button>
        </SettingRow>
        <SettingRow label="Screenshots" hint="Saved from the player">
          <Button variant="ghost" icon={<FolderOpen size={16} />} onClick={() => send({ t: 'open-folder', which: 'screenshots' })}>
            Open folder
          </Button>
        </SettingRow>
      </Group>
      <Group title="This profile">
        <SettingRow label="Clear local watch history" hint="Removes progress and watched marks kept on this PC. PublicMetaDB is not touched and fills it again on the next sync.">
          <Button variant="danger" icon={<Trash2 size={16} />} onClick={() => setConfirm(true)}>
            Clear
          </Button>
        </SettingRow>
      </Group>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Clear local history?"
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                useHistory.getState().clearAll();
                setConfirm(false);
                toast.success('Local history cleared');
              }}
            >
              Clear history
            </Button>
          </>
        }
      >
        <p className="dialog__text">Progress, watched marks and the local watchlist for this profile are removed from this PC. This cannot be undone here.</p>
      </Dialog>
    </>
  );
}

export function AboutSection() {
  return (
    <Group>
      <div className="about">
        <img src={markUrl} alt="" className="about__mark" />
        <div>
          <h3 className="about__name">ROVE</h3>
          <p className="about__version">Version {__APP_VERSION__}</p>
        </div>
      </div>
      <SettingRow label="Playback" hint="mpv (libmpv) with Direct3D 11 and libplacebo" />
      <SettingRow label="Window and page" hint="Rust with tao and wry on Microsoft Edge WebView2" />
      <SettingRow label="Metadata" hint="Your addons, plus TMDB when a key is set. This product uses the TMDB API but is not endorsed or certified by TMDB." />
      <SettingRow label="Skip times" hint="TheIntroDB, IntroDB, PublicMetaDB and AniSkip community data" />
    </Group>
  );
}
