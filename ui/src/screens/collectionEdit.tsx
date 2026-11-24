import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, FolderPlus, Pencil, Plus, Trash2, X } from 'lucide-react';
import { provides } from '../addons/client';
import { useAddons } from '../addons/store';
import { folderSources, useCollections, type CollectionFolder, type CollectionSource } from '../state/collections';
import { sourceKey, sourceLabel } from '../data/sources';
import { goBack, useNav } from '../nav/router';
import { Button, Dialog, Empty, IconButton, Segmented, Select, Switch, TextField } from '../ui/controls';
import { Img } from '../ui/Img';
import { toast } from '../ui/toast';
import { Group, SettingRow } from './settings/parts';

export function CollectionEdit({ id, folder: openFolder }: { id: string; folder?: string }) {
  const collection = useCollections((s) => s.collections.find((c) => c.id === id));
  const store = useCollections.getState();
  const replace = useNav((s) => s.replace);
  const [title, setTitle] = useState(collection?.title ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
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
        <SettingRow label="Pin to the top of Home" hint="Pinned collections sit above the other rows">
          <Switch checked={!!collection.pinToTop} onChange={(v) => store.update(id, { pinToTop: v })} label="Pin to the top" />
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

      <Group title={`Folders · ${collection.folders.length}`} note="Folders are the tiles in this collection's row on Home. Each one opens a set of sources: addon catalogs or TMDB lists.">
        <div className="s-row s-row--actions">
          <Button
            variant="secondary"
            icon={<FolderPlus size={16} />}
            onClick={() => {
              const f = store.addFolder(id, { title: 'New folder', tileShape: 'poster', sources: [] });
              replace({ name: 'collection-edit', id, folder: f.id });
            }}
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
                goBack();
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

function FolderEditor({ collectionId, folder, onClose }: { collectionId: string; folder: CollectionFolder; onClose: () => void }) {
  const store = useCollections.getState();
  const addons = useAddons((s) => s.addons);
  const [title, setTitle] = useState(folder.title);
  const [cover, setCover] = useState(folder.coverImageUrl ?? '');
  const [shape, setShape] = useState<'poster' | 'landscape'>((folder.tileShape ?? '').match(/landscape|wide/i) ? 'landscape' : 'poster');
  const [hideTitle, setHideTitle] = useState(!!folder.hideTitle);
  const [sources, setSources] = useState<CollectionSource[]>(folderSources(folder));
  const [adding, setAdding] = useState<'addon' | 'tmdb' | null>(null);

  const catalogs = useMemo(
    () =>
      addons
        .filter((a) => a.enabled && provides(a, 'catalog'))
        .flatMap((a) =>
          a.manifest.catalogs
            .filter((c) => !(c.extra ?? []).some((e) => e.isRequired && e.name !== 'genre'))
            .map((c) => ({ value: `${a.manifest.id}|${c.type}|${c.id}`, label: c.name, detail: `${a.manifest.name} · ${c.type}` })),
        ),
    [addons],
  );
  const [pick, setPick] = useState('');
  const [tmdbKind, setTmdbKind] = useState<(typeof TMDB_KINDS)[number]['value']>('LIST');
  const [tmdbId, setTmdbId] = useState('');
  const [tmdbMedia, setTmdbMedia] = useState<'movie' | 'tv'>('movie');

  const save = () => {
    store.updateFolder(collectionId, folder.id, { title: title.trim() || 'Folder', coverImageUrl: cover.trim() || null, tileShape: shape, hideTitle, sources, catalogSources: [] });
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
      title="Edit folder"
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
            <TextField label="Name" value={title} onChange={setTitle} data-autofocus />
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
          {sources.length === 0 && <p className="s-empty">No sources yet. Add a catalog from your addons or a TMDB list.</p>}
          <ul className="source-list">
            {sources.map((s, i) => (
              <li key={`${sourceKey(s)}-${i}`} className="source-list__item">
                <span className="source-list__text">
                  <span>{sourceLabel(s)}</span>
                  <span className="source-list__kind">{(s.provider ?? 'addon') === 'tmdb' ? `TMDB · ${s.tmdbSourceType?.toLowerCase()} ${s.tmdbId ?? ''}` : (s.provider ?? 'addon') === 'trakt' ? 'Trakt list' : `Addon · ${s.addonId}`}</span>
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
            ))}
          </ul>
          {adding === null && (
            <div className="inline-form">
              <Button variant="secondary" size="sm" icon={<Plus size={15} />} onClick={() => setAdding('addon')} disabled={!catalogs.length}>
                Addon catalog
              </Button>
              <Button variant="secondary" size="sm" icon={<Plus size={15} />} onClick={() => setAdding('tmdb')}>
                TMDB source
              </Button>
            </div>
          )}
          {adding === 'addon' && (
            <div className="inline-form">
              <Select label="Catalog" value={pick} options={[{ value: '', label: 'Choose a catalog' }, ...catalogs]} onChange={setPick} />
              <Button
                variant="primary"
                size="sm"
                disabled={!pick}
                onClick={() => {
                  const [addonId, type, catalogId] = pick.split('|');
                  setSources([...sources, { provider: 'addon', addonId, type, catalogId }]);
                  setPick('');
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
