import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, FolderPlus, Pencil, Plus, Trash2, X } from 'lucide-react';
import { canBrowse, canOpenType, catalogNeeds, genreOptions } from '../addons/client';
import { useAddons } from '../addons/store';
import { folderSources, useCollections, type CollectionFolder, type CollectionSource } from '../state/collections';
import { blockerMessage, sourceBlocker, sourceKey, sourceLabel, sourceOrigin } from '../data/sources';
import { ImportListsButton } from '../lists/ImportLists';
import { ListPickerDialog } from '../lists/ListPicker';
import { TRAKT_NEEDS_APP_ID } from '../lists/providers';
import type { ListProviderId } from '../lists/types';
import { goBack, useNav } from '../nav/router';
import { Button, Dialog, Empty, IconButton, Segmented, Select, Switch, TextField } from '../ui/controls';
import { Img } from '../ui/Img';
import { toast } from '../ui/toast';
import { Group, SettingRow } from './settings/parts';
import { CONTINUE_KEY, useHomeLayout } from '../state/homeLayout';

export function CollectionEdit({ id, folder: openFolder }: { id: string; folder?: string }) {
  const collection = useCollections((s) => s.collections.find((c) => c.id === id));
  // Folders that hold nothing but Trakt lists are kept but not shown by a build without ROVE's
  // Trakt app id. They are counted here so the page can say they exist.
  const hiddenFolders = useCollections((s) => (s.saved.find((c) => c.id === id)?.folders.length ?? 0) - (s.collections.find((c) => c.id === id)?.folders.length ?? 0));
  const store = useCollections.getState();
  const replace = useNav((s) => s.replace);
  const [title, setTitle] = useState(collection?.title ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [creating, setCreating] = useState(false);
  if (!collection) return <Empty title="This collection no longer exists" />;
  const editing = collection.folders.find((f) => f.id === openFolder);
  const rows = (collection.viewMode ?? '').toUpperCase() === 'ROWS';

  return (
    <div className="screen-pad edit-page">
      <header className="page-head">
        <div>
          <span className="crumb">Edit collection</span>
          <h1 className="page-title">{collection.title}</h1>
        </div>
        <Button variant="primary" onClick={goBack}>
          Done
        </Button>
      </header>

      <Group title="Collection">
        <SettingRow label="Name" stacked>
          <TextField value={title} onChange={setTitle} onBlur={() => title.trim() && store.update(id, { title: title.trim() })} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        </SettingRow>
        <SettingRow label="Pin to the top of Home" hint="Moves this row up, just under Continue Watching. Rows can still be reordered in Settings → Home layout.">
          <Switch
            checked={!!collection.pinToTop}
            onChange={(v) => {
              store.update(id, { pinToTop: v });
              if (v) {
                const layout = useHomeLayout.getState();
                const keys = [...layout.items].sort((a, b) => a.order - b.order).map((i) => i.key);
                layout.moveRow(`collection_${id}`, keys[0] === CONTINUE_KEY ? 1 : 0, keys);
              }
            }}
            label="Pin to the top"
          />
        </SettingRow>
        <SettingRow label="Opening a folder shows" hint="Its sources as tabs over one grid, or as rows">
          <Segmented
            label="Folder layout"
            value={rows ? 'ROWS' : 'TABBED_GRID'}
            onChange={(v) => store.update(id, { viewMode: v })}
            options={[
              { value: 'TABBED_GRID', label: 'Tabs' },
              { value: 'ROWS', label: 'Rows' },
            ]}
          />
        </SettingRow>
      </Group>

      <Group
        title={`Folders · ${collection.folders.length}`}
        note={
          <>
            Folders are the tiles in this collection's row on Home. Each one opens a set of sources: addon catalogs, TMDB sources, or lists from Trakt, MDBList and your media servers.
            {hiddenFolders > 0 && ` ${hiddenFolders} more ${hiddenFolders === 1 ? 'folder holds' : 'folders hold'} only Trakt lists: ${TRAKT_NEEDS_APP_ID}, so ${hiddenFolders === 1 ? 'it is' : 'they are'} kept but not shown.`}
          </>
        }
      >
        <div className="s-row s-row--actions">
          <ImportListsButton into={id} size="md">
            Import lists as folders
          </ImportListsButton>
          <Button
            variant="secondary"
            icon={<FolderPlus size={16} />}
            onClick={() => setCreating(true)}
          >
            Add folder
          </Button>
        </div>
        {collection.folders.map((f, i) => (
          <div key={f.id} className="folder-row">
            <Img src={f.coverImageUrl ?? undefined} alt="" className="folder-row__img" fallback={<span className="folder-row__mono">{f.coverEmoji ?? f.title[0]}</span>} />
            <div className="folder-row__text">
              <span className="folder-row__title">{f.title}</span>
              <span className="folder-row__sub">
                {folderSources(f).length} source{folderSources(f).length === 1 ? '' : 's'}
                {f.hideTitle ? ' · title hidden' : ''}
              </span>
            </div>
            <div className="folder-row__actions">
              <IconButton label="Edit folder" size="sm" onClick={() => replace({ name: 'collection-edit', id, folder: f.id })}>
                <Pencil size={15} />
              </IconButton>
              <IconButton label="Move up" size="sm" disabled={i === 0} onClick={() => store.moveFolder(id, f.id, i - 1)}>
                <ArrowUp size={16} />
              </IconButton>
              <IconButton label="Move down" size="sm" disabled={i === collection.folders.length - 1} onClick={() => store.moveFolder(id, f.id, i + 1)}>
                <ArrowDown size={16} />
              </IconButton>
              <IconButton
                label="Remove folder"
                size="sm"
                onClick={() => {
                  const removed = store.removeFolder(id, f.id);
                  if (removed) toast.info(`${f.title} removed`, { label: 'Undo', run: () => store.restoreFolder(id, removed, i) });
                }}
              >
                <Trash2 size={16} />
              </IconButton>
            </div>
          </div>
        ))}
      </Group>

      <Group title="Danger zone">
        <SettingRow label="Delete this collection" hint="Its row disappears from Home">
          <Button variant="danger" icon={<Trash2 size={16} />} onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </SettingRow>
      </Group>

      {editing && <FolderEditor collectionId={id} folder={editing} onClose={() => replace({ name: 'collection-edit', id })} />}
      {creating && <FolderEditor collectionId={id} folder={null} onClose={() => setCreating(false)} />}

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${collection.title}?`}
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const copy = collection;
                store.remove(id);
                // Its pages leave history with it (this one included), so neither this step nor a
                // later Back lands on "This collection no longer exists".
                useNav.getState().drop((r) => (r.name === 'collection' || r.name === 'collection-edit') && r.id === id);
                toast.info(`${copy.title} deleted`, { label: 'Undo', run: () => store.merge([copy]) });
              }}
            >
              Delete collection
            </Button>
          </>
        }
      >
        <p className="dialog__text">The row and its {collection.folders.length} folders leave Home. You can undo right after.</p>
      </Dialog>
    </div>
  );
}

const TMDB_KINDS = [
  { value: 'LIST', label: 'TMDB list' },
  { value: 'COLLECTION', label: 'TMDB film collection' },
  { value: 'COMPANY', label: 'Production company' },
  { value: 'NETWORK', label: 'TV network' },
  { value: 'PERSON', label: 'Actor' },
  { value: 'DIRECTOR', label: 'Director' },
] as const;

const isListProvider = (v: string | null): v is ListProviderId => v === 'trakt' || v === 'mdblist' || v === 'server';

/** Edits a folder, or with `folder` null makes a new one, which exists only once it is saved. */
function FolderEditor({ collectionId, folder, onClose }: { collectionId: string; folder: CollectionFolder | null; onClose: () => void }) {
  const store = useCollections.getState();
  const addons = useAddons((s) => s.addons);
  const [title, setTitle] = useState(folder?.title ?? '');
  const [cover, setCover] = useState(folder?.coverImageUrl ?? '');
  const [shape, setShape] = useState<'poster' | 'landscape'>((folder?.tileShape ?? '').match(/landscape|wide/i) ? 'landscape' : 'poster');
  const [hideTitle, setHideTitle] = useState(!!folder?.hideTitle);
  // The folder as it is saved, not as it is shown: a source this build cannot show is listed here
  // (with the reason) and is still there after Save.
  const [sources, setSources] = useState<CollectionSource[]>(() => {
    const saved = folder && store.saved.find((c) => c.id === collectionId)?.folders.find((f) => f.id === folder.id);
    return folder ? folderSources(saved ?? folder) : [];
  });
  const [adding, setAdding] = useState<'addon' | 'tmdb' | ListProviderId | null>(null);

  const catalogs = useMemo(
    () =>
      addons.filter(canBrowse).flatMap((a) =>
        a.manifest.catalogs
          // A catalog that needs more than a genre (a search text) cannot be a source.
          .filter((c) => canOpenType(c.type) && !catalogNeeds(c).some((n) => n !== 'genre'))
          .map((c) => ({
            value: `${a.manifest.id}|${c.type}|${c.id}`,
            label: c.name,
            detail: `${a.manifest.name} · ${c.type}`,
            addonId: a.manifest.id,
            type: c.type,
            catalogId: c.id,
            genres: genreOptions(c),
            genreRequired: catalogNeeds(c).includes('genre'),
          })),
      ),
    [addons],
  );
  const [pick, setPick] = useState('');
  const [genre, setGenre] = useState('');
  const picked = catalogs.find((c) => c.value === pick);
  const [tmdbKind, setTmdbKind] = useState<(typeof TMDB_KINDS)[number]['value']>('LIST');
  const [tmdbId, setTmdbId] = useState('');
  const [tmdbMedia, setTmdbMedia] = useState<'movie' | 'tv'>('movie');

  const save = () => {
    const data = { title: title.trim() || (folder ? 'Folder' : 'New folder'), coverImageUrl: cover.trim() || null, tileShape: shape, hideTitle, sources, catalogSources: [] };
    if (folder) store.updateFolder(collectionId, folder.id, data);
    else store.addFolder(collectionId, data);
    onClose();
  };

  const move = (i: number, to: number) => {
    const list = [...sources];
    const [x] = list.splice(i, 1);
    list.splice(to, 0, x);
    setSources(list);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={folder ? 'Edit folder' : 'New folder'}
      width={620}
      footer={
        <>
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <div className="folder-editor__top">
          <div className={`folder-editor__preview ${shape === 'landscape' ? 'is-wide' : ''}`}>
            <Img src={cover || undefined} alt="" className="folder-editor__img" fallback={<span className="folder-row__mono">{title[0] ?? '?'}</span>} />
            {!hideTitle && <span className="folder-editor__caption">{title}</span>}
          </div>
          <div className="form-stack">
            <TextField label="Name" value={title} onChange={setTitle} placeholder={folder ? undefined : 'New folder'} data-autofocus />
            <TextField label="Cover image link" value={cover} onChange={setCover} placeholder="https://…" />
            <div className="folder-editor__toggles">
              <Segmented
                label="Tile shape"
                value={shape}
                onChange={setShape}
                options={[
                  { value: 'poster', label: 'Poster' },
                  { value: 'landscape', label: 'Wide' },
                ]}
              />
              <label className="check-row">
                <Switch checked={hideTitle} onChange={setHideTitle} label="Hide the name on the tile" />
                <span>Hide name on tile</span>
              </label>
            </div>
          </div>
        </div>

        <div>
          <span className="field__label">Sources · {sources.length}</span>
          {sources.length === 0 && <p className="s-empty">No sources yet. Add a catalog from your addons, a TMDB source, or a list from Trakt, MDBList or a media server.</p>}
          <ul className="source-list">
            {sources.map((s, i) => {
              const why = sourceBlocker(s);
              return (
                <li key={`${sourceKey(s)}-${i}`} className="source-list__item">
                  <span className="source-list__text">
                    <span>{sourceLabel(s)}</span>
                    <span className="source-list__kind">
                      {sourceOrigin(s)}
                      {why && <span className="source-list__blocked"> · {blockerMessage(why).title}</span>}
                    </span>
                  </span>
                  <IconButton label="Move up" size="sm" disabled={i === 0} onClick={() => move(i, i - 1)}>
                    <ArrowUp size={15} />
                  </IconButton>
                  <IconButton label="Move down" size="sm" disabled={i === sources.length - 1} onClick={() => move(i, i + 1)}>
                    <ArrowDown size={15} />
                  </IconButton>
                  <IconButton label="Remove source" size="sm" onClick={() => setSources(sources.filter((_, j) => j !== i))}>
                    <X size={15} />
                  </IconButton>
                </li>
              );
            })}
          </ul>
          {(adding === null || isListProvider(adding)) && (
            <div className="inline-form inline-form--wrap">
              <Button variant="secondary" size="sm" icon={<Plus size={15} />} onClick={() => setAdding('addon')} disabled={!catalogs.length}>
                Addon catalog
              </Button>
              <Button variant="secondary" size="sm" icon={<Plus size={15} />} onClick={() => setAdding('tmdb')}>
                TMDB source
              </Button>
              <Button variant="secondary" size="sm" icon={<Plus size={15} />} onClick={() => setAdding('trakt')}>
                Trakt list
              </Button>
              <Button variant="secondary" size="sm" icon={<Plus size={15} />} onClick={() => setAdding('mdblist')}>
                MDBList list
              </Button>
              <Button variant="secondary" size="sm" icon={<Plus size={15} />} onClick={() => setAdding('server')}>
                Server list
              </Button>
            </div>
          )}
          {isListProvider(adding) && (
            <ListPickerDialog
              provider={adding}
              has={(key) => sources.some((s) => sourceKey(s) === key)}
              onAdd={(lists) => setSources((now) => [...now, ...lists.filter((l) => !now.some((s) => sourceKey(s) === l.key)).map((l) => l.source)])}
              onClose={() => setAdding(null)}
            />
          )}
          {adding === 'addon' && (
            <div className="inline-form inline-form--wrap">
              <Select
                label="Catalog"
                value={pick}
                options={[{ value: '', label: 'Choose a catalog' }, ...catalogs]}
                onChange={(v) => {
                  setPick(v);
                  // A catalog that only answers per genre starts on its first one.
                  const c = catalogs.find((x) => x.value === v);
                  setGenre(c?.genreRequired ? (c.genres[0] ?? '') : '');
                }}
              />
              {picked && picked.genres.length > 0 && (
                <Select label="Genre" value={genre} options={[...(picked.genreRequired ? [] : [{ value: '', label: 'Any genre' }]), ...picked.genres.map((g) => ({ value: g, label: g }))]} onChange={setGenre} />
              )}
              <Button
                variant="primary"
                size="sm"
                disabled={!picked}
                onClick={() => {
                  if (!picked) return;
                  setSources([...sources, { provider: 'addon', addonId: picked.addonId, type: picked.type, catalogId: picked.catalogId, ...(genre ? { genre } : {}) }]);
                  setPick('');
                  setGenre('');
                  setAdding(null);
                }}
              >
                Add
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAdding(null)}>
                Cancel
              </Button>
            </div>
          )}
          {adding === 'tmdb' && (
            <div className="inline-form inline-form--wrap">
              <Select label="TMDB source type" value={tmdbKind} options={TMDB_KINDS.map((k) => ({ value: k.value, label: k.label }))} onChange={setTmdbKind} />
              {tmdbKind !== 'COLLECTION' && tmdbKind !== 'NETWORK' && (
                <Segmented
                  label="Media"
                  value={tmdbMedia}
                  onChange={setTmdbMedia}
                  options={[
                    { value: 'movie', label: 'Movies' },
                    { value: 'tv', label: 'Shows' },
                  ]}
                />
              )}
              <TextField value={tmdbId} onChange={(v) => setTmdbId(v.replace(/\D/g, ''))} placeholder="TMDB id (the number in its link)" />
              <Button
                variant="primary"
                size="sm"
                disabled={!tmdbId}
                onClick={() => {
                  setSources([...sources, { provider: 'tmdb', tmdbSourceType: tmdbKind, tmdbId: Number(tmdbId), mediaType: tmdbKind === 'NETWORK' ? 'tv' : tmdbKind === 'COLLECTION' ? 'movie' : tmdbMedia }]);
                  setTmdbId('');
                  setAdding(null);
                }}
              >
                Add
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAdding(null)}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
