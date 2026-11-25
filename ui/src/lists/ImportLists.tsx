// Import lists: pick a provider, tick lists, and add them as rows on Home or as folders in a
// collection. Opened from Library → Collections, Settings → Home layout and a collection's editor.

import { useState } from 'react';
import { ListPlus } from 'lucide-react';
import { navigate } from '../nav/router';
import { useCollections } from '../state/collections';
import { Button, Dialog, Segmented, Select, TextField } from '../ui/controls';
import { toast } from '../ui/toast';
import { importAsFolders, importAsRows } from './importing';
import { ListBrowser, ProviderMissing, ProviderNote, toggled, type Picked } from './ListPicker';
import { useListProviders } from './providers';
import type { ListProviderId } from './types';

const NEW = '__new';
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** `into` opens it set to add folders to that collection; `start` opens it on that provider. */
export function ImportListsDialog({ onClose, into, start }: { onClose: () => void; into?: string; start?: ListProviderId }) {
  const { setup, providers } = useListProviders();
  const collections = useCollections((s) => s.collections);
  const [provider, setProvider] = useState<ListProviderId>(() => start ?? (providers.find((p) => p.ready) ?? providers[0]).id);
  const [picked, setPicked] = useState<Picked>(new Map());
  const [mode, setMode] = useState<'rows' | 'folders'>(into ? 'folders' : 'rows');
  const [target, setTarget] = useState(into ?? collections[0]?.id ?? NEW);
  const [newTitle, setNewTitle] = useState('');
  const status = providers.find((p) => p.id === provider)!;

  // Settings is another page: the dialog closes first, or it would stay up over it.
  const openSettings = (section: 'accounts' | 'servers') => {
    onClose();
    navigate({ name: 'settings', section });
  };

  const run = () => {
    const lists = [...picked.values()];
    if (!lists.length) return;
    onClose();
    if (mode === 'rows') {
      const r = importAsRows(lists);
      const left = r.skipped ? ` ${plural(r.skipped, 'was', 'were')} already there.` : '';
      if (!r.added) return void toast.info(lists.length === 1 ? 'That list already has a row on Home.' : 'Those lists already have rows on Home.');
      toast.success(`${plural(r.added, 'list', 'lists')} added to Home, under Continue Watching.${left}`, { label: 'Show on Home', run: () => navigate({ name: 'home' }) });
      return;
    }
    const r = importAsFolders(lists, target === NEW ? { title: newTitle.trim() || 'Lists' } : { collectionId: target });
    const left = r.skipped ? ` ${plural(r.skipped, 'was', 'were')} already in it.` : '';
    if (!r.added) return void toast.info(`${r.title} already has ${lists.length === 1 ? 'that list' : 'those lists'}.`);
    toast.success(`${plural(r.added, 'folder', 'folders')} added to ${r.title}.${left}`, { label: 'Open', run: () => navigate({ name: 'collection', id: r.collectionId }) });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Import lists"
      width={660}
      footer={
        <>
          <span className="dialog__count">{picked.size ? `${plural(picked.size, 'list', 'lists')} chosen` : status.ready ? 'Tick the lists you want' : ''}</span>
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!picked.size} onClick={run}>
            {picked.size > 1 ? `Import ${picked.size} lists` : 'Import list'}
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <div className="provider-tabs" role="radiogroup" aria-label="Where the lists come from">
          {providers.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={p.id === provider} className={`provider-tab ${p.id === provider ? 'is-on' : ''} ${p.ready ? '' : 'is-missing'}`} onClick={() => setProvider(p.id)}>
              <span className="provider-tab__name">{p.name}</span>
              <span className="provider-tab__state">{p.summary}</span>
            </button>
          ))}
        </div>

        {status.ready ? (
          <div>
            <ListBrowser key={provider} provider={provider} setup={setup} picked={picked} onToggle={(c) => setPicked((p) => toggled(p, c))} />
            <ProviderNote status={status} setup={setup} onSettings={openSettings} />
          </div>
        ) : (
          <ProviderMissing status={status} onSettings={openSettings} />
        )}

        {/* Where they go is asked once there is, or can be, something to add. */}
        {(status.ready || picked.size > 0) && (
          <div className="import-as">
            <span className="field__label">Add them as</span>
            <div className="import-as__row">
              <Segmented
                label="Add them as"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'rows', label: 'Rows on Home' },
                  { value: 'folders', label: 'Folders in a collection' },
                ]}
              />
              {mode === 'folders' && (
                <Select
                  label="Collection"
                  value={target}
                  onChange={setTarget}
                  options={[...collections.map((c) => ({ value: c.id, label: c.title, detail: plural(c.folders.length, 'folder', 'folders') })), { value: NEW, label: 'New collection…' }]}
                />
              )}
            </div>
            {mode === 'folders' && target === NEW && <TextField value={newTitle} onChange={setNewTitle} placeholder="Name of the new collection" aria-label="Name of the new collection" />}
            <p className="pick__note">
              {mode === 'rows'
                ? 'Each list becomes its own row of posters on Home. Move, rename or hide it in Settings → Home layout, or from the row’s menu.'
                : 'Each list becomes a folder tile in the collection’s row on Home, with the list as its source.'}
            </p>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** The way into Import lists: a button that opens the dialog. */
export function ImportListsButton({ into, variant = 'ghost', size, children = 'Import lists' }: { into?: string; variant?: 'secondary' | 'ghost'; size?: 'sm' | 'md'; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} icon={<ListPlus size={size === 'sm' ? 15 : 16} />} onClick={() => setOpen(true)}>
        {children}
      </Button>
      {open && <ImportListsDialog into={into} onClose={() => setOpen(false)} />}
    </>
  );
}
