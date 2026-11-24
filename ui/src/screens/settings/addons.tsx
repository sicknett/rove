import { useState } from 'react';
import { ArrowDown, ArrowUp, ExternalLink, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { addonHost, useAddons } from '../../addons/store';
import { provides, type Resource } from '../../addons/client';
import type { InstalledAddon } from '../../addons/types';
import { Button, IconButton, Switch, TextField } from '../../ui/controls';
import { Img } from '../../ui/Img';
import { toast } from '../../ui/toast';
import { send } from '../../bridge';
import { Group } from './parts';

const RESOURCES: { id: Resource; label: string }[] = [
  { id: 'catalog', label: 'Catalogs' },
  { id: 'meta', label: 'Metadata' },
  { id: 'stream', label: 'Streams' },
  { id: 'subtitles', label: 'Subtitles' },
];

export function AddonsSection() {
  const addons = useAddons((s) => s.addons);
  const { add, refreshManifests } = useAddons.getState();
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const a = await add(link);
      setLink('');
      toast.success(`${a.manifest.name} installed`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That addon could not be added.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Group title="Add an addon" note="Paste the manifest link from the addon's configure page (it ends in /manifest.json). Links can carry your configuration, so they are stored encrypted.">
        <div className="inline-form inline-form--pad">
          <TextField value={link} onChange={setLink} placeholder="https://…/manifest.json" error={error} onKeyDown={(e) => e.key === 'Enter' && link.trim() && void submit()} />
          <Button variant="primary" icon={<Plus size={16} />} busy={busy} disabled={!link.trim()} onClick={() => void submit()}>
            Install
          </Button>
        </div>
      </Group>
      <Group
        title={`Installed · ${addons.length}`}
        note="Order matters: metadata and sources are asked in this order, and the first addon's answer wins for metadata."
      >
        <div className="s-row s-row--actions">
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={15} className={refreshing ? 'spin' : ''} />}
            onClick={async () => {
              setRefreshing(true);
              await refreshManifests();
              setRefreshing(false);
              toast.success('Addons refreshed');
            }}
          >
            Refresh all
          </Button>
        </div>
        {addons.map((a, i) => (
          <AddonRow key={a.url} addon={a} index={i} count={addons.length} />
        ))}
        {!addons.length && <p className="s-empty">No addons yet. Add a metadata addon (such as AIOMetadata or Cinemeta) and a stream addon (such as AIOStreams) above.</p>}
      </Group>
    </>
  );
}

function AddonRow({ addon, index, count }: { addon: InstalledAddon; index: number; count: number }) {
  const { setEnabled, move, remove, toggleResource, add } = useAddons.getState();
  const m = addon.manifest;
  const configurable = m.behaviorHints?.configurable;
  return (
    <div className={`addon ${addon.enabled ? '' : 'is-off'}`}>
      <Img src={m.logo} alt="" className="addon__logo" fallback={<span className="addon__mono">{m.name[0]}</span>} />
      <div className="addon__text">
        <div className="addon__title">
          <span className="addon__name">{m.name}</span>
          <span className="addon__version">v{m.version}</span>
          <span className="addon__host">{addonHost(addon.url)}</span>
        </div>
        {m.description && <p className="addon__desc">{m.description}</p>}
        <div className="chips">
          {RESOURCES.filter((r) => provides({ ...addon, disabledResources: [] }, r.id)).map((r) => {
            const on = !(addon.disabledResources ?? []).includes(r.id);
            return (
              <button key={r.id} className={`chip chip--sm ${on ? 'is-on' : ''}`} aria-pressed={on} title={on ? `Stop using its ${r.label.toLowerCase()}` : `Use its ${r.label.toLowerCase()}`} onClick={() => toggleResource(addon.url, r.id)}>
                {r.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="addon__actions">
        <Switch checked={addon.enabled} onChange={(v) => setEnabled(addon.url, v)} label={`${m.name} enabled`} />
        <IconButton label="Move up" size="sm" disabled={index === 0} onClick={() => move(addon.url, index - 1)}>
          <ArrowUp size={16} />
        </IconButton>
        <IconButton label="Move down" size="sm" disabled={index === count - 1} onClick={() => move(addon.url, index + 1)}>
          <ArrowDown size={16} />
        </IconButton>
        {configurable && (
          <IconButton label="Configure" size="sm" onClick={() => send({ t: 'open-external', url: addon.url.replace(/\/manifest\.json$/i, '/configure') })}>
            <ExternalLink size={16} />
          </IconButton>
        )}
        <IconButton
          label="Remove"
          size="sm"
          onClick={() => {
            remove(addon.url);
            toast.info(`${m.name} removed`, { label: 'Undo', run: () => void add(addon.url).catch(() => toast.error('Could not reinstall it')) });
          }}
        >
          <Trash2 size={16} />
        </IconButton>
      </div>
    </div>
  );
}
