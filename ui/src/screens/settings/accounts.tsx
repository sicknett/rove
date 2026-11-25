import { useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, RefreshCw, Unplug } from 'lucide-react';
import { send } from '../../bridge';
import { useTracker, syncNow } from '../../tracking/sync';
import { connectMdblist, connectPmdb, startDeviceSignIn, type DeviceSignIn } from '../../tracking/connect';
import { trackerAvailable } from '../../tracking/adapters';
import type { TrackerId } from '../../tracking/types';
import { BUILT_IN_TMDB_KEY, useKeys } from '../../state/keys';
import { checkTmdbKey } from '../../meta/tmdb';
import { Button, Segmented, TextField } from '../../ui/controls';
import { toast } from '../../ui/toast';
import { AssistantCard } from '../../ai/AssistantCard';
import { ago, hostOf } from './format';
import { Group, SettingRow } from './parts';

// Settings → Accounts: the services ROVE signs in to for you. One tracker per profile; the AI
// assistant and the TMDB key serve every profile. (Where titles and streams come from is under
// Addons and Media servers.)

export function AccountsSection() {
  return (
    <>
      <TrackerCard />
      <AssistantCard />
      <TmdbCard />
    </>
  );
}

const TRACKERS: { id: TrackerId; label: string; blurb: string }[] = [
  { id: 'pmdb', label: 'PublicMetaDB', blurb: 'History, progress and watchlist, plus community skip times. Works with apps like Strand.' },
  { id: 'trakt', label: 'Trakt', blurb: 'History, progress and watchlist. Sign in with a short code at trakt.tv.' },
  { id: 'simkl', label: 'Simkl', blurb: 'History, progress and plan-to-watch. Sign in with a short code at simkl.com.' },
  { id: 'mdblist', label: 'MDBList', blurb: 'History, progress and watchlist with your MDBList API key.' },
];

function TrackerCard() {
  const t = useTracker();
  const [pick, setPick] = useState<TrackerId>('pmdb');
  const info = TRACKERS.find((x) => x.id === (t.account?.provider ?? pick))!;

  const disconnect = async () => {
    const was = t.account;
    if (!was) return;
    await t.disconnect();
    // Signing in again would need the key or a new code; Undo puts the same sign-in back and syncs.
    toast.info(`${info.label} disconnected. Your history stays on this PC.`, { label: 'Undo', run: () => void useTracker.getState().setAccount(was) });
  };

  return (
    <Group
      id="accounts.tracker"
      title="Tracking"
      note="ROVE always keeps Continue Watching, history and your watchlist on this PC. Connect one tracker per profile and every change syncs both ways, so your other devices and apps stay in step. Sign-ins are stored encrypted for your Windows account."
    >
      {t.account ? (
        <SettingRow
          label={t.state === 'unauthorized' ? `${info.label} sign-in no longer accepted` : `Connected to ${info.label}${t.account.username ? ` as ${t.account.username}` : ''}`}
          hint={
            t.state === 'syncing'
              ? 'Syncing…'
              : t.message ?? `${t.lastSyncAt ? `Last synced ${ago(t.lastSyncAt)}` : 'Not synced yet'}${t.counts ? ` · ${t.counts.resume} in progress · ${t.counts.watched} watched` : ''}`
          }
        >
          <Button variant="secondary" icon={<RefreshCw size={16} className={t.state === 'syncing' ? 'spin' : ''} />} disabled={t.state === 'syncing'} onClick={() => void syncNow()}>
            Sync now
          </Button>
          <Button variant="ghost" icon={<Unplug size={16} />} onClick={() => void disconnect()}>
            Disconnect
          </Button>
        </SettingRow>
      ) : (
        <>
          <SettingRow label="Tracker" hint={info.blurb} stacked>
            <Segmented label="Tracker" value={pick} onChange={setPick} options={TRACKERS.map((x) => ({ value: x.id, label: x.label }))} />
          </SettingRow>
          {pick === 'pmdb' && <KeyConnect key="pmdb" name="PublicMetaDB" hint="Create one at publicmetadb.com under Settings → API." placeholder="pm-…" connect={connectPmdb} />}
          {pick === 'mdblist' && <KeyConnect key="mdblist" name="MDBList" hint="Find it at mdblist.com under Preferences → API access." placeholder="Your MDBList API key" connect={connectMdblist} />}
          {(pick === 'trakt' || pick === 'simkl') && <DeviceConnect key={pick} provider={pick} name={info.label} />}
        </>
      )}
    </Group>
  );
}

function KeyConnect({ name, hint, placeholder, connect }: { name: string; hint: string; placeholder: string; connect: (key: string) => Promise<void> }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await connect(key);
      setKey('');
      toast.success(`${name} connected. Importing your history…`);
    } catch (e) {
      setError(e instanceof Error ? e.message : `Could not reach ${name}.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingRow label="API key" hint={hint} stacked>
      <div className="inline-form">
        <TextField value={key} onChange={setKey} placeholder={placeholder} secret error={error} onKeyDown={(e) => e.key === 'Enter' && key.trim() && void go()} />
        <Button variant="primary" busy={busy} disabled={!key.trim()} onClick={() => void go()}>
          Connect
        </Button>
      </div>
    </SettingRow>
  );
}

function DeviceConnect({ provider, name }: { provider: 'trakt' | 'simkl'; name: string }) {
  const [code, setCode] = useState<DeviceSignIn | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef<DeviceSignIn | null>(null);
  useEffect(() => () => live.current?.cancel(), []);

  if (!trackerAvailable(provider))
    return (
      <SettingRow label={`${name} is not set up in this build`} hint={`${name} sign-in needs ROVE\u2019s ${name} app id, which is added when ROVE is built.`} />
    );

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await startDeviceSignIn(provider);
      live.current = c;
      setCode(c);
      setBusy(false);
      send({ t: 'open-external', url: c.verificationUrl });
      const ok = await c.done;
      if (live.current !== c) return;
      live.current = null;
      setCode(null);
      if (ok) toast.success(`${name} connected. Importing your history…`);
      else setError('The code expired or was declined. Try again.');
    } catch (e) {
      setCode(null);
      setError(e instanceof Error ? e.message : `Could not reach ${name}.`);
    } finally {
      setBusy(false);
    }
  };

  if (code)
    return (
      <SettingRow label={`Enter this code at ${hostOf(code.verificationUrl)}`} hint="Waiting for you to approve ROVE. This updates on its own." stacked>
        <div className="device-code">
          <span className="device-code__value">{code.userCode}</span>
          <Button variant="secondary" icon={<Copy size={16} />} onClick={() => void navigator.clipboard?.writeText(code.userCode).then(() => toast.success('Code copied'))}>
            Copy
          </Button>
          <Button variant="secondary" icon={<ExternalLink size={16} />} onClick={() => send({ t: 'open-external', url: code.verificationUrl })}>
            Open {name}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              code.cancel();
              live.current = null;
              setCode(null);
            }}
          >
            Cancel
          </Button>
        </div>
      </SettingRow>
    );

  return (
    <SettingRow label={`Sign in with ${name}`} hint={error ?? `ROVE shows a short code; approve it on ${name} in your browser.`}>
      <Button variant="primary" busy={busy} onClick={() => void start()}>
        Sign in
      </Button>
    </SettingRow>
  );
}

function TmdbCard() {
  const current = useKeys((s) => s.tmdbApiKey);
  const setKey = useKeys((s) => s.setTmdbApiKey);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // TMDB is asked about the key before it is saved. A key it refuses would replace ROVE's own
  // and quietly switch off art, cast and trailers.
  const save = async () => {
    if (busy || !value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const accepted = await checkTmdbKey(value).catch(() => null);
      if (accepted === null) return setError('TMDB could not be reached to check the key. Try again.');
      if (!accepted) return setError('TMDB did not accept that key. Copy the API key or the read token again.');
      await setKey(value);
      setValue('');
      toast.success('TMDB key saved');
    } catch {
      setError('The key could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    const was = current;
    void setKey(null);
    if (was) toast.info(BUILT_IN_TMDB_KEY ? 'Your TMDB key is removed. ROVE’s own key is in use again.' : 'Your TMDB key is removed', { label: 'Undo', run: () => void useKeys.getState().setTmdbApiKey(was) });
  };

  return (
    <Group
      id="accounts.tmdb"
      title="TMDB"
      note={
        BUILT_IN_TMDB_KEY
          ? 'Logo art, cast, trailers, recommendations and collections come from TMDB. ROVE includes its own key, so there is nothing to do here unless you would rather use your own TMDB quota. One key serves every profile.'
          : 'Optional, but it adds logo art, cast, trailers, recommendations and age ratings. A free key comes from themoviedb.org → Settings → API. One key serves every profile.'
      }
    >
      {current ? (
        <SettingRow label="Using your own key" hint={`Ends in …${current.slice(-4)}.${BUILT_IN_TMDB_KEY ? ' Remove it to go back to ROVE’s key.' : ''}`}>
          <Button variant="ghost" onClick={remove}>
            Remove
          </Button>
        </SettingRow>
      ) : (
        <SettingRow label={BUILT_IN_TMDB_KEY ? 'Using ROVE’s key' : 'API key or read token'} hint={BUILT_IN_TMDB_KEY ? 'Paste your own key to use it instead. TMDB is asked about it before it is saved.' : undefined} stacked>
          <div className="inline-form">
            <TextField value={value} onChange={(v) => (setValue(v), setError(null))} secret placeholder="Paste your TMDB key" error={error} onKeyDown={(e) => e.key === 'Enter' && void save()} />
            <Button variant="primary" busy={busy} disabled={!value.trim()} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </SettingRow>
      )}
    </Group>
  );
}
