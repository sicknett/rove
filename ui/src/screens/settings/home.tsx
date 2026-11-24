import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Sparkles, RotateCcw } from 'lucide-react';
import { catalogKey, homeCatalogs } from '../../addons/client';
import { isServerAddon } from '../../servers';
import { useCatalogSources } from '../../servers/useSources';
import { useCollections } from '../../state/collections';
import { CONTINUE_KEY, useHomeLayout } from '../../state/homeLayout';
import { useSettings } from '../../state/settings';
import { Button, IconButton, Switch, TextField } from '../../ui/controls';
import { Group, SettingRow } from './parts';

export function HomeSection() {
  const addons = useCatalogSources();
  const collections = useCollections((s) => s.collections);
  const layout = useHomeLayout();
  const appearance = useSettings((s) => s.settings.appearance);
  const set = useSettings((s) => s.set);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const rows = useMemo(() => {
    const names = new Map<string, { title: string; detail: string }>([[CONTINUE_KEY, { title: 'Continue Watching', detail: 'Resume points and next episodes' }]]);
    for (const a of addons.filter((x) => x.enabled))
      for (const c of homeCatalogs(a))
        names.set(catalogKey(a, c), isServerAddon(a) ? { title: c.name, detail: 'Media server' } : { title: `${c.name} · ${c.type === 'movie' ? 'Movies' : c.type === 'series' ? 'Shows' : c.type}`, detail: a.manifest.name });
    for (const c of collections) names.set(`collection_${c.id}`, { title: c.title, detail: `Collection · ${c.folders.length} folders${c.pinToTop ? ' · pinned' : ''}` });
    return [...layout.items]
      .filter((i) => names.has(i.key))
      .sort((a, b) => a.order - b.order)
      .map((i) => ({ ...i, ...names.get(i.key)! }));
  }, [addons, collections, layout.items]);

  const visibleKeys = rows.map((r) => r.key);

  return (
    <>
      <Group title="Top of Home">
        <SettingRow label="Featured banner" hint="Rotating titles with their art, from the rows marked with a star">
          <Switch checked={layout.heroEnabled && appearance.heroEnabled} onChange={(v) => (layout.setHeroEnabled(v), set('appearance', { heroEnabled: v }))} label="Featured banner" />
        </SettingRow>
        <SettingRow label="Play trailers in the banner" hint="Muted, after a few seconds on a title">
          <Switch checked={appearance.heroTrailers} onChange={(v) => set('appearance', { heroTrailers: v })} label="Trailers in the banner" />
        </SettingRow>
        <SettingRow label="Wide Continue Watching cards" hint="Episode stills instead of posters">
          <Switch checked={appearance.landscapeContinueWatching} onChange={(v) => set('appearance', { landscapeContinueWatching: v })} label="Wide Continue Watching cards" />
        </SettingRow>
      </Group>
      <Group title="Rows" note="Turn rows on or off, rename them, and move them. The star marks rows the banner takes titles from (two at most is best). Pinned collections stay at the top.">
        <div className="s-row s-row--actions">
          <Button variant="ghost" size="sm" icon={<RotateCcw size={15} />} onClick={() => layout.reset()}>
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
              {r.key !== CONTINUE_KEY && !r.key.startsWith('collection_') && (
                <IconButton label={r.hero ? 'Stop featuring this row' : 'Feature this row in the banner'} size="sm" active={r.hero} onClick={() => layout.setRow(r.key, { hero: !r.hero })}>
                  <Sparkles size={16} />
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
