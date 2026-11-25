// Settings → Data: backing up and moving to another PC, what ROVE keeps on disk, and, set apart
// at the end, the one thing here that removes something for good.

import { useRef, useState } from 'react';
import { Download, FolderOpen, KeyRound, Share2, Trash2, Upload } from 'lucide-react';
import { readBackup, restoreBackup, saveBackup } from '../../lib/backup';
import { useQueryClient } from '@tanstack/react-query';
import { invalidate } from '../../lib/http';
import { send } from '../../bridge';
import { useHistory } from '../../state/history';
import { useProfiles } from '../../state/profiles';
import { trackerName, useTracker } from '../../tracking/sync';
import { Button, Dialog, Switch } from '../../ui/controls';
import { toast } from '../../ui/toast';
import { count } from './format';
import { Group, SettingRow } from './parts';
import { CreateCodeDialog, UseCodeDialog } from './share';

export function DataSection() {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [withKeys, setWithKeys] = useState(false);
  const [saving, setSaving] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  // A chosen backup waits here until the user confirms: restoring replaces this PC's setup.
  const [chosen, setChosen] = useState<ReturnType<typeof readBackup> | null>(null);
  const [restoring, setRestoring] = useState(false);
  // Sharing with a code: its own switch for keys, off every time this page opens.
  const [shareKeys, setShareKeys] = useState(false);
  const [sharing, setSharing] = useState<'create' | 'use' | null>(null);
  const tracker = useTracker((s) => s.account?.provider);
  // Named once there is more than one profile, so it is clear whose history goes.
  const profileName = useProfiles((s) => (s.profiles.length > 1 ? s.profiles.find((p) => p.id === s.activeId)?.name : undefined));
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
      toast.success(`Restored ${count(summary.addons, 'addon')} and ${count(summary.profiles, 'profile')}. Reloading…`);
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
        title="Back up and move"
        note="A backup holds your addons, your profiles, and each profile’s settings, Home layout, collections and track choices. Addon links are always in it, and they can carry your configuration and its keys, so keep every backup private. Watch history is not in it: a tracker brings that to every device."
      >
        <SettingRow id="data.backupKeys" hint="Adds your tracker and media server sign-ins and your TMDB, MDBList and AI assistant keys, so the other PC needs no signing in. Keep that file like a password.">
          <Switch checked={withKeys} onChange={setWithKeys} label="Put sign-ins and keys in the backup" />
        </SettingRow>
        <SettingRow id="data.backup" hint={withKeys ? 'Saves one .json file with your setup, sign-ins and keys.' : 'Saves one .json file with your setup, without sign-ins or keys.'}>
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
        <SettingRow id="data.restore" hint="Replaces the addons, profiles and settings on this PC with the backup’s. You see what is in the file and confirm before anything changes.">
          <Button variant="secondary" icon={<Upload size={16} />} onClick={() => file.current?.click()}>
            Restore…
          </Button>
          <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => (e.target.files?.[0] && void choose(e.target.files[0]), (e.target.value = ''))} />
        </SettingRow>
      </Group>

      <Group
        title="Share your setup"
        note="A code gives a friend your addons, profiles, settings, Home layout and collections. ROVE encrypts a copy on this PC and keeps it at paste.unredacted.org (privatebin.net if that one does not answer) for up to a week. Those services cannot read it: the key is only in the code, so only someone with the code can. Addon links are shared as they are, and a link can carry that addon’s configuration and its keys. Watch history, recent searches and profile PINs stay on this PC."
      >
        <SettingRow id="data.shareKeys">
          <Switch checked={shareKeys} onChange={setShareKeys} label="Include API keys and sign-ins" />
        </SettingRow>
        <SettingRow id="data.shareCreate" hint={shareKeys ? 'Makes a code for your setup with your keys and sign-ins. You see what is shared before anything is sent.' : 'Makes a code for your setup, without keys or sign-ins. You see what is shared before anything is sent.'}>
          <Button variant="secondary" icon={<Share2 size={16} />} onClick={() => setSharing('create')}>
            Create a code…
          </Button>
        </SettingRow>
        <SettingRow id="data.shareUse">
          <Button variant="secondary" icon={<KeyRound size={16} />} onClick={() => setSharing('use')}>
            Use a code…
          </Button>
        </SettingRow>
      </Group>

      <Group title="Storage">
        <SettingRow id="data.cache">
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
        <SettingRow id="data.logs">
          <Button variant="ghost" icon={<FolderOpen size={16} />} onClick={() => send({ t: 'open-folder', which: 'logs' })}>
            Open folder
          </Button>
        </SettingRow>
        <SettingRow id="data.screenshots">
          <Button variant="ghost" icon={<FolderOpen size={16} />} onClick={() => send({ t: 'open-folder', which: 'screenshots' })}>
            Open folder
          </Button>
        </SettingRow>
      </Group>

      <Group title="Remove" tone="danger">
        <SettingRow
          id="data.clearHistory"
          label={profileName ? `Clear ${profileName}’s watch history on this PC` : undefined}
          hint={
            tracker
              ? `Removes progress, watched marks and the local watchlist. ${trackerName(tracker)} is not touched, and fills them in again at the next sync.`
              : 'Removes progress, watched marks and the local watchlist. No tracker is connected, so nothing can bring them back.'
          }
        >
          <Button variant="danger" icon={<Trash2 size={16} />} onClick={() => setConfirm(true)}>
            Clear history…
          </Button>
        </SettingRow>
      </Group>

      <CreateCodeDialog open={sharing === 'create'} includeKeys={shareKeys} onClose={() => setSharing(null)} />
      <UseCodeDialog open={sharing === 'use'} onClose={() => setSharing(null)} />
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
