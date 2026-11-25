import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, FolderPen, Pencil, Sparkles, RotateCcw, Trash2 } from 'lucide-react';
import { navigate } from '../../nav/router';
import { catalogKey, homeCatalogs } from '../../addons/client';
import { isServerAddon } from '../../servers';
import { useCatalogSources } from '../../servers/useSources';
import { LIST_ROW_PREFIX, listRowKey, useCollections } from '../../state/collections';
import { sourceOrigin } from '../../data/sources';
import { ImportListsButton } from '../../lists/ImportLists';
import { removeListRow } from '../../lists/ListRow';
import { CONTINUE_KEY, FOR_YOU_KEY, isSmartKey, useHomeLayout } from '../../state/homeLayout';
import { useRecs } from '../../recs/engine';
import { useHiddenCount, useSmartRowDefs } from '../../recs/hooks';
import { BUILT_IN_TMDB_KEY, useKeys } from '../../state/keys';
import { assistantName, useAssistantSettings } from '../../ai';
import { useSettings } from '../../state/settings';
import { Button, IconButton, Select, Switch, TextField } from '../../ui/controls';
import { Group, SettingRow } from './parts';

export function HomeSection() {
  const addons = useCatalogSources();
  const collections = useCollections((s) => s.collections);
  const lists = useCollections((s) => s.lists);
  const layout = useHomeLayout();
  const appearance = useSettings((s) => s.settings.appearance);
  const set = useSettings((s) => s.set);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const assistant = useAssistantSettings();
  // The rows made from what the profile watches. None while they are switched off (or without a TMDB key).
  const smart = useSmartRowDefs();
  const hiddenCount = useHiddenCount();
  const hasTmdbKey = useKeys((s) => !!(s.tmdbApiKey ?? BUILT_IN_TMDB_KEY));

  const { rows, keys } = useMemo(() => {
    const names = new Map<string, { title: string; detail: string }>([[CONTINUE_KEY, { title: 'Continue Watching', detail: 'Resume points and next episodes' }]]);
    // Only while an assistant is connected: without one the row does not exist on Home either.
    if (assistant) names.set(FOR_YOU_KEY, { title: 'For you', detail: `Recommendations from ${assistantName(assistant)}, from what you watched` });
    for (const d of smart) names.set(d.key, { title: d.title, detail: d.detail });
    for (const a of addons.filter((x) => x.enabled))
      for (const c of homeCatalogs(a))
        names.set(catalogKey(a, c), isServerAddon(a) ? { title: c.name, detail: 'Media server' } : { title: `${c.name} · ${c.type === 'movie' ? 'Movies' : c.type === 'series' ? 'Shows' : c.type}`, detail: a.manifest.name });
    for (const c of collections) names.set(`collection_${c.id}`, { title: c.title, detail: `Collection · ${c.folders.length} folders` });
    // Lists imported as rows of their own, named with where each comes from.
    for (const l of lists) names.set(listRowKey(l.id), { title: l.title, detail: `List · ${sourceOrigin(l.source)}` });
    const rows = [...layout.items]
      .filter((i) => names.has(i.key))
      .sort((a, b) => a.order - b.order)
      .map((i) => ({ ...i, ...names.get(i.key)! }));
    // Every row that exists now, in the order Home first lists them (what a reset starts from).
    return { rows, keys: [...names.keys()] };
  }, [addons, collections, lists, layout.items, assistant, smart]);

  const visibleKeys = rows.map((r) => r.key);

  return (
    <>
      <Group title="Top of Home">
        <SettingRow label="Featured banner" hint="Rotating titles with their art, from the rows marked with a star">
          <Switch checked={layout.heroEnabled && appearance.heroEnabled} onChange={(v) => (layout.setHeroEnabled(v), set('appearance', { heroEnabled: v }))} label="Featured banner" />
        </SettingRow>
        <SettingRow label="Banner shows" hint="Automatic takes titles from the starred rows below, or the first row when none is starred">
          <Select
            label="Banner shows"
            value={appearance.heroSource}
            onChange={(v) => set('appearance', { heroSource: v })}
            options={[
              { value: 'auto', label: 'Automatic' },
              { value: 'continue', label: 'Continue Watching' },
              { value: 'watchlist', label: 'My watchlist' },
            ]}
          />
        </SettingRow>
        <SettingRow label="Play trailers in the banner" hint="The trailer fades in over the picture and the banner moves on when it ends. Sound is off until you turn it on with the button on the banner">
          <Switch checked={appearance.heroTrailers} onChange={(v) => set('appearance', { heroTrailers: v })} label="Trailers in the banner" />
        </SettingRow>
        {appearance.heroTrailers && (
          <SettingRow label="Trailers start" hint="By themselves after a moment on a title, or only while the pointer rests on the banner">
            <Select
              label="Trailers start"
              value={appearance.heroTrailerStart}
              onChange={(v) => set('appearance', { heroTrailerStart: v })}
              options={[
                { value: 'auto', label: 'Automatically' },
                { value: 'hover', label: 'On hover' },
              ]}
            />
          </SettingRow>
        )}
        <SettingRow label="Wide Continue Watching cards" hint="Episode stills instead of posters">
          <Switch checked={appearance.landscapeContinueWatching} onChange={(v) => set('appearance', { landscapeContinueWatching: v })} label="Wide Continue Watching cards" />
        </SettingRow>
      </Group>
      <Group title="Made for you">
        <SettingRow
          label="Rows made for you"
          hint={
            hasTmdbKey
              ? 'Top picks, Because you watched, Trending, the Top 10s, New releases and your genres, worked out on this PC from what you watch and looked up on TMDB. No account and no AI key needed. Each row can be moved, renamed or switched off below.'
              : 'These rows are looked up on TMDB, and this build has no TMDB key. Add one in Settings → Accounts.'
          }
        >
          <Switch checked={appearance.smartRows} onChange={(v) => set('appearance', { smartRows: v })} label="Rows made for you" />
        </SettingRow>
        {appearance.smartRows && hiddenCount > 0 && (
          <SettingRow label="Not interested" hint={`${hiddenCount} ${hiddenCount === 1 ? 'title is' : 'titles are'} kept out of these rows because you marked ${hiddenCount === 1 ? 'it' : 'them'} Not interested`}>
            <Button variant="secondary" size="sm" onClick={() => useRecs.getState().clearHidden()}>
              Allow {hiddenCount === 1 ? 'it' : 'them'} again
            </Button>
          </SettingRow>
        )}
      </Group>
      <Group title="Rows" note="Turn rows on or off, rename them, and move them. The star marks rows the banner takes titles from (two at most is best). The folder button opens a collection's folders for editing, and the bin takes an imported list off Home. Home shows rows in this order.">
        <div className="s-row s-row--actions">
          <ImportListsButton size="sm" />
          <Button
            variant="ghost"
            size="sm"
            icon={<RotateCcw size={15} />}
            onClick={() =>
              layout.reset(
                keys,
                // Placed right after Continue Watching, as when they first appeared.
                [...smart.map((d) => d.key), ...collections.filter((c) => c.pinToTop).map((c) => `collection_${c.id}`)],
              )
            }
          >
            Reset layout
          </Button>
        </div>
        {rows.map((r, i) => (
          <div key={r.key} className={`layout-row ${r.enabled ? '' : 'is-off'}`}>
            <Switch checked={r.enabled} onChange={(v) => layout.setRow(r.key, { enabled: v })} label={`Show ${r.title}`} />
            <div className="layout-row__text">
              {editing === r.key ? (
                <TextField
                  autoFocus
                  value={draft}
                  onChange={setDraft}
                  placeholder={r.title}
                  onBlur={() => (layout.setRow(r.key, { customTitle: draft.trim() || undefined }), setEditing(null))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setEditing(null);
                  }}
                />
              ) : (
                <>
                  <span className="layout-row__title">{r.customTitle || r.title}</span>
                  <span className="layout-row__detail">{r.customTitle ? `${r.title} · ${r.detail}` : r.detail}</span>
                </>
              )}
            </div>
            <div className="layout-row__actions">
              {r.key !== CONTINUE_KEY && r.key !== FOR_YOU_KEY && !isSmartKey(r.key) && !r.key.startsWith('collection_') && !r.key.startsWith(LIST_ROW_PREFIX) && (
                <IconButton label={r.hero ? 'Stop featuring this row' : 'Feature this row in the banner'} size="sm" active={r.hero} onClick={() => layout.setRow(r.key, { hero: !r.hero })}>
                  <Sparkles size={16} />
                </IconButton>
              )}
              {r.key.startsWith('collection_') && (
                <IconButton label="Edit folders" size="sm" onClick={() => navigate({ name: 'collection-edit', id: r.key.slice('collection_'.length) })}>
                  <FolderPen size={16} />
                </IconButton>
              )}
              {r.key.startsWith(LIST_ROW_PREFIX) && (
                <IconButton label="Remove this list from Home" size="sm" onClick={() => removeListRow(r.key.slice(LIST_ROW_PREFIX.length), r.customTitle || r.title)}>
                  <Trash2 size={16} />
                </IconButton>
              )}
              <IconButton label="Rename" size="sm" onClick={() => (setEditing(r.key), setDraft(r.customTitle ?? ''))}>
                <Pencil size={15} />
              </IconButton>
              <IconButton label="Move up" size="sm" disabled={i === 0} onClick={() => layout.moveRow(r.key, i - 1, visibleKeys)}>
                <ArrowUp size={16} />
              </IconButton>
              <IconButton label="Move down" size="sm" disabled={i === rows.length - 1} onClick={() => layout.moveRow(r.key, i + 1, visibleKeys)}>
                <ArrowDown size={16} />
              </IconButton>
            </div>
          </div>
        ))}
      </Group>
    </>
  );
}
