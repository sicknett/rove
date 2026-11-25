import { useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, RefreshCw, Server, Trash2 } from 'lucide-react';
import { send } from '../../bridge';
import { normalizeUrl } from '../../servers/http';
import { probeServer, signInWithPassword, startQuickConnect, type PublicInfo, type QuickConnectCode } from '../../servers/jellyfin';
import { pickConnection, plexServers, startPlexSignIn, type PlexPin, type PlexServerChoice } from '../../servers/plex';
import { serverAdapter } from '../../servers';
import { useServers } from '../../servers/store';
import { SERVER_KIND_NAMES, type MediaServer, type ServerKind, type ServerLibrary } from '../../servers/types';
import { Button, Segmented, Switch, TextField } from '../../ui/controls';
import { toast } from '../../ui/toast';
import { count, hostOf } from './format';
import { Group, SettingRow } from './parts';

type NewServer = Omit<MediaServer, 'id' | 'addedAt' | 'enabled'>;

/** Saves a signed-in server with its libraries, and says so only as far as it went. */
async function addServer(s: NewServer) {
  const libraries: ServerLibrary[] | null = await serverAdapter(s.kind)
    .libraries({ ...s, id: 'new', enabled: true, addedAt: 0 })
    .catch(() => null);
  useServers.getState().add(libraries ? { ...s, libraries } : s);
  if (!libraries) toast.info(`${s.name} added, but its libraries could not be read. Use Refresh to try again.`);
  else if (!libraries.length) toast.info(`${s.name} added. It has no movie or show libraries yet.`);
  else toast.success(`${s.name} added. Its libraries are on Home now.`);
}

export function ServersSection() {
  const servers = useServers((s) => s.servers);
  return (
    <>
      <Group
        id="servers.list"
        title="Your servers"
        note="Titles on your servers show up on Home, in Search and as sources next to your addons, so the same movie or episode is one title whether it comes from a server or an addon. ROVE plays the original file directly and tells the server where you stopped. Sign-ins are stored encrypted for your Windows account and shared by every profile."
      >
        {servers.length === 0 && <SettingRow label="No servers yet" hint="Add a Jellyfin, Emby, Silo or Plex server below." />}
        {servers.map((s, i) => (
          <ServerRow key={s.id} server={s} index={i} />
        ))}
      </Group>
      <AddServer />
    </>
  );
}

function ServerRow({ server, index }: { server: MediaServer; index: number }) {
  const [busy, setBusy] = useState(false);
  const store = useServers.getState();
  const libs = server.libraries ?? [];
  const refresh = async () => {
    setBusy(true);
    try {
      const libraries = await store.refresh(server.id);
      toast.success(`${server.name}: ${count(libraries.length, 'library', 'libraries')}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `${server.name} could not be reached.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingRow
      label={`${server.name} · ${SERVER_KIND_NAMES[server.kind]}`}
      hint={`${server.enabled ? '' : 'Switched off · '}${server.userName ? `${server.userName} · ` : ''}${libs.length ? libs.map((l) => l.name).join(', ') : 'No libraries found'} · ${hostOf(server.url)}`}
    >
      <Switch checked={server.enabled} onChange={(v) => store.update(server.id, { enabled: v })} label={`Use ${server.name}`} />
      <Button variant="ghost" icon={<RefreshCw size={16} className={busy ? 'spin' : ''} />} disabled={busy} onClick={() => void refresh()}>
        Refresh
      </Button>
      <Button
        variant="ghost"
        icon={<Trash2 size={16} />}
        onClick={() => {
          store.remove(server.id);
          toast.info(`${server.name} removed`, { label: 'Undo', run: () => useServers.getState().restore(server, index) });
        }}
      >
        Remove
      </Button>
    </SettingRow>
  );
}

function AddServer() {
  const [kind, setKind] = useState<ServerKind>('jellyfin');
  return (
    <Group id="servers.add" title="Add a server">
      <SettingRow label="Server type" hint={kind === 'silo' ? 'Silo servers speak the same language as Jellyfin.' : kind === 'plex' ? 'Sign in with your Plex account, then pick a server.' : 'Sign in with your username and password, or Quick Connect where the server has it on.'} stacked>
        <Segmented label="Server type" value={kind} onChange={setKind} options={(['jellyfin', 'emby', 'silo', 'plex'] as ServerKind[]).map((k) => ({ value: k, label: SERVER_KIND_NAMES[k] }))} />
      </SettingRow>
      {kind === 'plex' ? <PlexSignIn /> : <JellyfinSignIn key={kind} kind={kind} />}
    </Group>
  );
}

function JellyfinSignIn({ kind }: { kind: ServerKind }) {
  const [url, setUrl] = useState('');
  const [info, setInfo] = useState<(PublicInfo & { url: string }) | null>(null);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qc, setQc] = useState<QuickConnectCode | null>(null);
  const live = useRef<QuickConnectCode | null>(null);
  useEffect(() => () => live.current?.cancel(), []);

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      const base = normalizeUrl(url);
      const found = await probeServer(base, kind);
      setInfo({ ...found, kind: kind === 'silo' ? 'silo' : found.kind, url: base });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nothing answered at that address.');
    } finally {
      setBusy(false);
    }
  };

  const signIn = async () => {
    if (!info) return;
    setBusy(true);
    setError(null);
    try {
      await addServer(await signInWithPassword(info.url, info.kind, user.trim(), pass, info.name));
      setInfo(null);
      setUrl('');
      setUser('');
      setPass('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  const quickConnect = async () => {
    if (!info) return;
    setError(null);
    try {
      const code = await startQuickConnect(info.url, info.kind, info.name);
      live.current = code;
      setQc(code);
      const result = await code.done;
      if (live.current !== code) return;
      live.current = null;
      setQc(null);
      if (result) {
        await addServer(result);
        setInfo(null);
        setUrl('');
      } else setError('Quick Connect timed out. Try again.');
    } catch (e) {
      setQc(null);
      setError(e instanceof Error ? e.message : 'Quick Connect is not available on this server.');
    }
  };

  if (!info)
    return (
      <SettingRow label="Server address" hint={error ?? 'For example http://192.168.1.20:8096 or https://media.example.com'} stacked>
        <div className="inline-form">
          <TextField value={url} onChange={setUrl} placeholder="http://server:8096" aria-label="Server address" onKeyDown={(e) => e.key === 'Enter' && url.trim() && void check()} />
          <Button variant="primary" busy={busy} disabled={!url.trim()} onClick={() => void check()}>
            Continue
          </Button>
        </div>
      </SettingRow>
    );

  if (qc)
    return (
      <SettingRow label={`Enter this code in ${info.name}`} hint="In the server's web app: your profile → Quick Connect. ROVE carries on by itself once you approve it." stacked>
        <div className="device-code">
          <span className="device-code__value">{qc.code}</span>
          <Button variant="secondary" icon={<Copy size={16} />} onClick={() => void navigator.clipboard?.writeText(qc.code).then(() => toast.success('Code copied'))}>
            Copy
          </Button>
          <Button variant="secondary" icon={<ExternalLink size={16} />} onClick={() => send({ t: 'open-external', url: `${info.url}/web/#/quickconnect` })}>
            Open {info.name}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              qc.cancel();
              live.current = null;
              setQc(null);
            }}
          >
            Cancel
          </Button>
        </div>
      </SettingRow>
    );

  return (
    <>
      <SettingRow label={`${info.name} · ${SERVER_KIND_NAMES[info.kind]}${info.version ? ` ${info.version}` : ''}`} hint={info.url}>
        <Button variant="ghost" onClick={() => setInfo(null)}>
          Change address
        </Button>
      </SettingRow>
      <SettingRow label="Sign in" hint={error ?? (info.kind === 'silo' ? 'Silo profiles sign in as user#profile.' : undefined)} stacked>
        <div className="inline-form inline-form--wrap">
          <TextField value={user} onChange={setUser} placeholder="Username" aria-label="Username" />
          <TextField value={pass} onChange={setPass} placeholder="Password" aria-label="Password" secret onKeyDown={(e) => e.key === 'Enter' && user.trim() && void signIn()} />
          <Button variant="primary" busy={busy} disabled={!user.trim()} onClick={() => void signIn()}>
            Sign in
          </Button>
          {info.quickConnect && (
            <Button variant="secondary" onClick={() => void quickConnect()}>
              Use Quick Connect
            </Button>
          )}
        </div>
      </SettingRow>
    </>
  );
}

function PlexSignIn() {
  const [pin, setPin] = useState<PlexPin | null>(null);
  const [choices, setChoices] = useState<PlexServerChoice[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef<PlexPin | null>(null);
  useEffect(() => () => live.current?.cancel(), []);
  const existing = useServers((s) => s.servers);

  const start = async () => {
    setBusy('signin');
    setError(null);
    try {
      const p = await startPlexSignIn();
      live.current = p;
      setPin(p);
      setBusy(null);
      send({ t: 'open-external', url: p.authUrl });
      const token = await p.done;
      if (live.current !== p) return;
      live.current = null;
      setPin(null);
      if (!token) return setError('The sign-in expired. Try again.');
      const list = await plexServers(token);
      if (!list.length) return setError('This Plex account has no servers.');
      setChoices(list);
    } catch (e) {
      setPin(null);
      setError(e instanceof Error ? e.message : 'Could not reach Plex.');
    } finally {
      setBusy(null);
    }
  };

  const choose = async (c: PlexServerChoice) => {
    setBusy(c.machineId);
    setError(null);
    try {
      const url = await pickConnection(c);
      await addServer({ kind: 'plex', name: c.name, url, token: c.token, machineId: c.machineId, connections: c.connections });
    } catch (e) {
      setError(e instanceof Error ? e.message : `${c.name} could not be reached.`);
    } finally {
      setBusy(null);
    }
  };

  if (pin)
    return (
      <SettingRow label="Approve ROVE in your browser" hint="Plex opened in your browser. Sign in there and allow ROVE; this carries on by itself." stacked>
        <div className="device-code">
          <Button variant="secondary" icon={<ExternalLink size={16} />} onClick={() => send({ t: 'open-external', url: pin.authUrl })}>
            Open Plex again
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              pin.cancel();
              live.current = null;
              setPin(null);
            }}
          >
            Cancel
          </Button>
        </div>
      </SettingRow>
    );

  if (choices)
    return (
      <>
        {choices.map((c) => {
          const added = existing.some((s) => s.kind === 'plex' && s.machineId === c.machineId);
          return (
            <SettingRow key={c.machineId} label={c.name} hint={`${c.owned ? 'Your server' : 'Shared with you'} · ${c.connections.length} address${c.connections.length === 1 ? '' : 'es'}`}>
              <Button variant={added ? 'ghost' : 'primary'} icon={<Server size={16} />} busy={busy === c.machineId} disabled={!!busy} onClick={() => void choose(c)}>
                {added ? 'Update' : 'Add'}
              </Button>
            </SettingRow>
          );
        })}
        {error && <SettingRow label="Could not add it" hint={error} />}
        <SettingRow label="Done adding Plex servers?">
          <Button variant="ghost" onClick={() => setChoices(null)}>
            Done
          </Button>
        </SettingRow>
      </>
    );

  return (
    <SettingRow label="Sign in with Plex" hint={error ?? 'Your browser opens plex.tv to approve ROVE. Your Plex password never passes through ROVE.'}>
      <Button variant="primary" busy={busy === 'signin'} onClick={() => void start()}>
        Sign in
      </Button>
    </SettingRow>
  );
}
