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
  // A chosen backup waits here until the user confirms: restoring replaces this PC's setup.
  const [chosen, setChosen] = useState<ReturnType<typeof readBackup> | null>(null);
  const [restoring, setRestoring] = useState(false);
  const choose = async (f: File) => {
    try {
      setChosen(readBackup(await f.text()));
    } catch (e) {
      toast.error(e instanceof Error && !(e instanceof SyntaxError) ? e.message : 'That file is not a ROVE backup.');
    }
  };
  const restore = async () => {
    if (!chosen || restoring) return;
    setRestoring(true);
    try {
      const summary = await restoreBackup(chosen);
      toast.success(`Restored ${summary.addons} addon${summary.addons === 1 ? '' : 's'} and ${summary.profiles} profile${summary.profiles === 1 ? '' : 's'}. Reloading…`);
      window.setTimeout(() => location.reload(), 900);
    } catch {
      setRestoring(false);
      setChosen(null);
      toast.error('The backup could not be restored. Some of it may have been written: restore it again, or restart ROVE.');
    }
  };
  const chosenDate = chosen && !Number.isNaN(Date.parse(chosen.createdAt)) ? new Date(chosen.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' }) : null;
  return (
    <>
      <Group
        title="Back up and move to another PC"
        note="A backup holds your addons, profiles, and each profile's settings, Home layout, collections and track choices. Addon links are always in it, and they can carry your configuration and its keys, so keep every backup private. Watch history is not in it: your tracker brings that to every device."
      >
        <SettingRow label="Include sign-ins and keys" hint="Adds your tracker sign-ins, your media server sign-ins and your TMDB key. Keep that file like a password.">
          <Switch checked={withKeys} onChange={setWithKeys} label="Include sign-ins and keys" />
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
          <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => (e.target.files?.[0] && void choose(e.target.files[0]), (e.target.value = ''))} />
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
        open={!!chosen}
        onClose={() => !restoring && setChosen(null)}
        title="Restore this backup?"
        width={460}
        footer={
          <>
            <Button variant="ghost" disabled={restoring} onClick={() => setChosen(null)}>
              Cancel
            </Button>
            <Button variant="danger" busy={restoring} onClick={() => void restore()}>
              Restore
            </Button>
          </>
        }
      >
        {chosen && (
          <p className="dialog__text">
            The addons, profiles and settings on this PC are replaced with the backup's: {chosen.addons.length} addon{chosen.addons.length === 1 ? '' : 's'} and {chosen.profiles.profiles.length} profile
            {chosen.profiles.profiles.length === 1 ? '' : 's'}
            {chosenDate ? `, saved ${chosenDate}` : ''}.{chosen.keys || chosen.servers ? ' Its sign-ins and keys replace the ones here.' : ''} Watch history on this PC is kept. This cannot be undone.
          </p>
        )}
      </Dialog>
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
