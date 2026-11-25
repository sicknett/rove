import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ExternalLink, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { AddonConflict, addonHost, ADDONS_UNREADABLE, useAddons } from '../../addons/store';
import { provides, type Resource } from '../../addons/client';
import type { InstalledAddon } from '../../addons/types';
import { Button, Dialog, IconButton, Switch, TextField } from '../../ui/controls';
import { Img } from '../../ui/Img';
import { toast } from '../../ui/toast';
import { send } from '../../bridge';
import { Group, SettingRow } from './parts';

const RESOURCES: { id: Resource; label: string }[] = [
  { id: 'catalog', label: 'Catalogs' },
  { id: 'meta', label: 'Metadata' },
  { id: 'stream', label: 'Streams' },
  { id: 'subtitles', label: 'Subtitles' },
];

/**
 * Installing from a pasted link, for Settings and first-run setup. One install at a time (Enter
 * held or pressed twice is one install), and a link for an addon that is already installed under
 * another configuration is put to the user as a replacement (see ReplaceAddonDialog).
 */
export function useAddonInstall(onInstalled?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ link: string; found: AddonConflict } | null>(null);
  const running = useRef(false);

  const install = async (link: string, replace = false) => {
    if (running.current || !link.trim()) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const a = await useAddons.getState().add(link, { replace });
      setConflict(null);
      toast.success(replace ? `${a.manifest.name} replaced` : `${a.manifest.name} installed`);
      onInstalled?.();
    } catch (e) {
      if (e instanceof AddonConflict) setConflict({ link, found: e });
      else {
        setConflict(null);
        setError(e instanceof Error ? e.message : 'That addon could not be added.');
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return { busy, error, conflict, install, replace: () => conflict && install(conflict.link, true), cancel: () => setConflict(null) };
}

/** Asks before a link takes the place of the installed addon it is another configuration of. */
export function ReplaceAddonDialog({ state }: { state: ReturnType<typeof useAddonInstall> }) {
  const existing = state.conflict?.found.existing;
  return (
    <Dialog
      open={!!existing}
      onClose={state.cancel}
      title={existing ? `Replace ${existing.manifest.name}?` : undefined}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={state.cancel}>
            Cancel
          </Button>
          <Button variant="primary" busy={state.busy} onClick={() => void state.replace()}>
            Replace
          </Button>
        </>
      }
    >
      <p className="dialog__text">
        This link is {existing?.manifest.name} again, set up differently from the one installed ({existing ? addonHost(existing.url) : ''}). ROVE keeps one of them. Replacing keeps its place in the list and its switches.
      </p>
    </Dialog>
  );
}

export function AddonsSection() {
  const addons = useAddons((s) => s.addons);
  const unreadable = useAddons((s) => s.loadFailed);
  const { refreshManifests, load } = useAddons.getState();
  const [link, setLink] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const adding = useAddonInstall(() => setLink(''));

  // The saved list is there but could not be read: nothing can be added or changed until it can.
  if (unreadable)
    return (
      <Group title="Addons">
        <SettingRow label="Your addons could not be loaded" hint={ADDONS_UNREADABLE}>
          <Button variant="primary" onClick={() => void load()}>
            Try again
          </Button>
        </SettingRow>
      </Group>
    );

  return (
    <>
      <Group title="Add an addon" note="Paste the manifest link from the addon's configure page (it ends in /manifest.json). Links can carry your configuration, so they are stored encrypted.">
        <div className="inline-form inline-form--pad">
          <TextField value={link} onChange={setLink} placeholder="https://…/manifest.json" error={adding.error} onKeyDown={(e) => e.key === 'Enter' && void adding.install(link)} />
          <Button variant="primary" icon={<Plus size={16} />} busy={adding.busy} disabled={!link.trim()} onClick={() => void adding.install(link)}>
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
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              try {
                const { failed } = await refreshManifests();
                if (!failed.length) toast.success('Addons refreshed');
                else toast.error(`${failed.join(', ')} did not answer. ${failed.length < addons.length ? 'The others were refreshed.' : 'Nothing was refreshed.'}`);
              } finally {
                setRefreshing(false);
              }
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
      <ReplaceAddonDialog state={adding} />
    </>
  );
}

function AddonRow({ addon, index, count }: { addon: InstalledAddon; index: number; count: number }) {
  const { setEnabled, move, remove, toggleResource, restore } = useAddons.getState();
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
            // Undo puts back the addon as it was, where it was: no request, so it works offline too.
            toast.info(`${m.name} removed`, {
              label: 'Undo',
              run: () => {
                if (!restore(addon, index)) toast.error(`${m.name} is installed again already`);
              },
            });
          }}
        >
          <Trash2 size={16} />
        </IconButton>
      </div>
    </div>
  );
}
