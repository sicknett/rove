// Settings → Home layout: everything about the banner in one place, the options for rows, and
// the rows themselves (on or off, names, order, which ones feed the banner).

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
import { useSettings, type Settings } from '../../state/settings';
import { Button, IconButton, Segmented, Switch, TextField } from '../../ui/controls';
import { toast } from '../../ui/toast';
import { count } from './format';
import { Anchor, Group, SeeAlso, SettingLink, SettingRow } from './parts';

type HeroSource = Settings['appearance']['heroSource'];

const SOURCE_HINT: Record<HeroSource, string> = {
  auto: 'Titles from the rows starred in the list below, or from the first row when none is starred.',
  continue: 'What you are partway through. With nothing in progress, the starred rows fill in.',
  watchlist: 'The newest titles on your watchlist. While it is empty, the starred rows fill in.',
};

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
    for (const c of collections) names.set(`collection_${c.id}`, { title: c.title, detail: `Collection · ${count(c.folders.length, 'folder')}` });
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
  const shown = rows.filter((r) => r.enabled).length;
  const starred = rows.filter((r) => r.hero && r.enabled).length;

  // The banner is switched in two places that are kept the same: the Home layout and the appearance settings.
  const bannerOn = layout.heroEnabled && appearance.heroEnabled;
  const bannerOff = !bannerOn && 'The banner is off.';
  const needsTmdb = (what: string) => (
    <>
      {what} come from TMDB, and there is no TMDB key. Add one under <SettingLink to="accounts.tmdb">Accounts</SettingLink>.
    </>
  );

  const resetRows = () => {
    const before = { heroEnabled: layout.heroEnabled, items: layout.items };
    layout.reset(
      keys,
      // Placed right after Continue Watching, as when they first appeared.
      [...smart.map((d) => d.key), ...collections.filter((c) => c.pinToTop).map((c) => `collection_${c.id}`)],
    );
    toast.info('Every row is back on, under its own name, in the original order', {
      label: 'Undo',
      run: () => {
        // The saved order and names go back as they were; the switch that follows writes them out.
        useHomeLayout.setState({ items: before.items });
        useHomeLayout.getState().setHeroEnabled(before.heroEnabled);
      },
    });
  };

  return (
    <>
      <Group title="Banner">
        <SettingRow id="appearance.heroEnabled">
          <Switch checked={bannerOn} onChange={(v) => (layout.setHeroEnabled(v), set('appearance', { heroEnabled: v }))} label="Show the banner" />
        </SettingRow>
        <SettingRow id="appearance.heroSource" hint={SOURCE_HINT[appearance.heroSource]} disabled={bannerOff}>
          <Segmented<HeroSource>
            label="The banner features"
            value={appearance.heroSource}
            onChange={(v) => set('appearance', { heroSource: v })}
            options={[
              { value: 'auto', label: 'Starred rows' },
              { value: 'continue', label: 'Continue Watching' },
              { value: 'watchlist', label: 'My watchlist' },
            ]}
          />
        </SettingRow>
        <SettingRow id="appearance.heroTrailers" disabled={bannerOff || (!hasTmdbKey && needsTmdb('Trailers'))}>
          <Switch checked={appearance.heroTrailers} onChange={(v) => set('appearance', { heroTrailers: v })} label="Play trailers in the banner" />
        </SettingRow>
        <SettingRow id="appearance.heroTrailerStart" disabled={bannerOff || (!hasTmdbKey && needsTmdb('Trailers')) || (!appearance.heroTrailers && 'Banner trailers are off.')}>
          <Segmented
            label="Banner trailers start"
            value={appearance.heroTrailerStart}
            onChange={(v) => set('appearance', { heroTrailerStart: v })}
            options={[
              { value: 'auto', label: 'By themselves' },
              { value: 'hover', label: 'When pointed at' },
            ]}
          />
        </SettingRow>
      </Group>

      <Group title="Rows">
        <SettingRow id="appearance.landscapeContinueWatching">
          <Switch checked={appearance.landscapeContinueWatching} onChange={(v) => set('appearance', { landscapeContinueWatching: v })} label="Wide Continue Watching cards" />
        </SettingRow>
        <SettingRow id="appearance.smartRows" disabled={!hasTmdbKey && needsTmdb('These rows')}>
          <Switch checked={appearance.smartRows} onChange={(v) => set('appearance', { smartRows: v })} label="Rows made for you" />
        </SettingRow>
        {appearance.smartRows && hiddenCount > 0 && (
          <SettingRow id="home.notInterested" hint={`${hiddenCount === 1 ? '1 title is' : `${hiddenCount} titles are`} kept out of the rows made for you because you marked ${hiddenCount === 1 ? 'it' : 'them'} Not interested.`}>
            <Button variant="secondary" size="sm" onClick={() => useRecs.getState().clearHidden()}>
              Allow {hiddenCount === 1 ? 'it' : 'them'} again
            </Button>
          </SettingRow>
        )}
      </Group>

      <Group
        id="home.rows"
        title={`Row order · ${shown} of ${rows.length} shown`}
        note={
          <>
            Home shows the rows in this order. The star marks a row the banner takes titles from when it features starred rows ({starred ? `${count(starred, 'row')} now` : 'none now, so it uses the first row'}; two at most works best). The
            folder opens a collection’s folders, and the bin takes an imported list off Home.
          </>
        }
      >
        <div className="s-row s-row--actions">
          <Anchor id="home.import">
            <ImportListsButton size="sm" />
          </Anchor>
          <Anchor id="home.resetRows">
            <Button variant="ghost" size="sm" icon={<RotateCcw size={15} />} onClick={resetRows}>
              Reset rows
            </Button>
          </Anchor>
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
                  aria-label={`Name for ${r.title}`}
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
                <IconButton label={r.hero ? 'Stop featuring this row in the banner' : 'Feature this row in the banner'} size="sm" active={r.hero} aria-pressed={!!r.hero} onClick={() => layout.setRow(r.key, { hero: !r.hero })}>
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
        {!rows.length && <p className="s-empty">No rows yet. Rows appear here once an addon with catalogs, a media server or a collection is added.</p>}
      </Group>

      <SeeAlso>
        Poster size, ratings and hover previews are under <SettingLink to="appearance.cardSize">Appearance</SettingLink>.
      </SeeAlso>
    </>
  );
}
