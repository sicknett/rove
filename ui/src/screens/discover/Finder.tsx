// Discover's main mode: narrow all of TMDB down to something to watch. A bar of filters, the
// filters in force as chips that can be taken away, ready-made starting points, "Surprise me",
// and the grid of what matches. The filters live in the route (see filters.ts); this draws them.
//
// Requests while it is on show: one page of 20 per grid page, as it is scrolled (20 pages at
// most); the count above the grid reads the first of those from the cache and adds none; the
// watch providers of one country and the list of countries are asked for once each, and only
// after "Where to watch" has been opened or a provider is already in the filters.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Award, CalendarClock, Camera, Dices, Gem, Hourglass, Landmark, Rewind, RotateCcw, Users, X } from 'lucide-react';
import { flatItems } from '../../data/hooks';
import { useSourceItems } from '../../data/sources';
import { paging, PosterGrid } from '../../media/Grid';
import { discoverPage, tmdbImage, watchProviders, watchRegions } from '../../meta/tmdb';
import { discoverRequest } from '../../meta/tmdbSources';
import { useScreen } from '../../nav/router';
import { sourceKey } from '../../state/collections';
import { useProfiles } from '../../state/profiles';
import { Button, Empty, IconButton, Segmented, Select } from '../../ui/controls';
import { Tile } from '../shared/cards';
import { Featured } from '../shared/Featured';
import { genresOf, type Kind } from '../shared/genres';
import { hitKey } from '../shared/hits';
import { LoadFailed, useTmdbKeyId } from '../shared/parts';
import {
  activeChips,
  activePreset,
  applyPreset,
  chosen,
  countLabel,
  defaultRegion,
  describe,
  isNarrowed,
  kindOf,
  LANGUAGES,
  languageName,
  LENGTH_CHOICES,
  lengthLabel,
  normalize,
  presetsFor,
  RATING_CHOICES,
  ratingLabel,
  SORT_CHOICES,
  toSource,
  whenChoices,
  whenLabel,
  withKind,
  type DiscoverFilters,
  type Preset,
} from './filters';
import { MultiSelect } from './MultiSelect';
import { SaveRow } from './SaveRow';
import { useSurprise } from './useSurprise';

const MINUTE = 60 * 1000;
/** The grid follows a filter set this far (data/sources.ts stops a TMDB source after 20 pages of 20). */
const GRID_REACH = 400;
/** "Where to watch" lists the biggest services of the country; the long tail is hundreds of channels and stores. */
const PROVIDERS_SHOWN = 30;

const PRESET_ICON: Record<Preset['id'], typeof Award> = { acclaimed: Award, gems: Gem, short: Hourglass, nineties: Rewind, fresh: CalendarClock, documentaries: Camera, family: Users, classics: Landmark };

const REGION_KEY = 'rove.watchRegion';

/** The country last picked for where to watch, on this computer. */
function storedRegion(): string | null {
  try {
    const v = localStorage.getItem(REGION_KEY);
    return v && /^[A-Z]{2}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

const regionNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
const regionName = (code: string) => {
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
};

interface Props {
  filters: DiscoverFilters;
  onChange: (next: DiscoverFilters) => void;
  /** The switch to the addon catalogs, when there are any. */
  modeSwitch?: React.ReactNode;
}

export function Finder({ filters, onChange, modeSwitch }: Props) {
  const screen = useScreen();
  const keyId = useTmdbKeyId();
  const kids = useProfiles((s) => !!s.profiles.find((p) => p.id === s.activeId)?.kids);
  const kind = kindOf(filters);
  const set = (patch: DiscoverFilters) => onChange(normalize({ ...filters, ...patch }));

  // One source for everything below: the grid, the count, and the row "Save to Home" makes.
  const source = useMemo(() => toSource(filters, { kids }), [filters, kids]);
  const q = useSourceItems(source, screen.active);
  const items = flatItems(q.data?.pages);
  const pages = paging(q);
  const totals = useQuery({
    queryKey: ['discover', 'totals', sourceKey(source), keyId],
    queryFn: ({ signal }) => {
      const r = discoverRequest(source, 1);
      return discoverPage(r.kind, r.params, signal);
    },
    enabled: screen.active && !!keyId,
    staleTime: 20 * MINUTE,
  });
  const total = totals.data?.totalResults;

  // Where to watch. The country is the one in the filters when providers are chosen, else the one
  // last picked here, else the system's.
  const [homeRegion, setHomeRegion] = useState(() => storedRegion() ?? defaultRegion(navigator.languages?.length ? navigator.languages : [navigator.language]));
  const [opened, setOpened] = useState(false);
  const region = filters.region ?? homeRegion;
  const picked = filters.providers ?? [];
  const providers = useQuery({
    queryKey: ['discover', 'providers', kind, region, keyId],
    queryFn: ({ signal }) => watchProviders(kind, region, signal),
    enabled: screen.active && !!keyId && (opened || picked.length > 0),
    staleTime: 24 * 60 * MINUTE,
  });
  const regions = useQuery({
    queryKey: ['discover', 'regions', keyId],
    queryFn: ({ signal }) => watchRegions(signal),
    enabled: screen.active && !!keyId && opened,
    staleTime: 24 * 60 * MINUTE,
  });
  const providerName = (id: number) => providers.data?.find((p) => p.provider_id === id)?.provider_name;
  const providerOptions = useMemo(() => {
    const all = providers.data ?? [];
    // The biggest services, and whatever is chosen even when it is not one of them. Not the
    // channels sold inside another service ("HBO Max Amazon Channel"): the list is of places to
    // have an account, and each of those is in it already.
    const services = all.filter((p) => picked.includes(p.provider_id) || !/ (Amazon|Apple TV|Roku Premium) Channel\s*$/i.test(p.provider_name));
    const shown = [...services.slice(0, PROVIDERS_SHOWN), ...services.slice(PROVIDERS_SHOWN).filter((p) => picked.includes(p.provider_id))];
    return shown.map((p) => ({ value: p.provider_id, label: p.provider_name, image: tmdbImage(p.logo_path, 'w92') }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.data, picked.join(',')]);
  const regionOptions = useMemo(() => {
    const listed = (regions.data ?? []).map((r) => ({ value: r.iso_3166_1, label: r.english_name }));
    // Until the list arrives (and if it never does) the country in use is still named.
    const all = listed.some((r) => r.value === region) ? listed : [{ value: region, label: regionName(region) }, ...listed];
    return all.sort((a, b) => a.label.localeCompare(b.label));
  }, [regions.data, region]);
  const changeRegion = (next: string) => {
    setHomeRegion(next);
    try {
      localStorage.setItem(REGION_KEY, next);
    } catch {
      // Remembered for this run only.
    }
    if (picked.length) set({ region: next });
  };

  const year = new Date().getFullYear();
  const when = chosen(whenChoices(year), filters, ['from', 'to', 'recent'], whenLabel(filters));
  const rating = chosen(RATING_CHOICES, filters, ['rating'], ratingLabel(filters));
  const length = chosen(LENGTH_CHOICES, filters, ['runtimeMin', 'runtimeMax'], lengthLabel(filters));
  const languages = useMemo(() => {
    const known = LANGUAGES.map((l) => ({ value: l.code, label: l.name }));
    const own = filters.language && !LANGUAGES.some((l) => l.code === filters.language) ? [{ value: filters.language, label: languageName(filters.language) }] : [];
    return [{ value: '', label: 'Any language' }, ...own, ...known];
  }, [filters.language]);

  const narrowed = isNarrowed(filters);
  const chips = activeChips(filters, { provider: providerName });
  const preset = activePreset(filters);
  const surprise = useSurprise(filters, kids);
  const reset = () => onChange(normalize({ kind: filters.kind }));
  const setOf = <T,>(choices: { value: string; set: T }[], value: string) => choices.find((c) => c.value === value)?.set;

  return (
    <>
      <header className="page-head">
        <h1 className="page-title">Discover</h1>
        <div className="page-head__controls">
          <Button variant="primary" icon={<Dices size={17} />} busy={surprise.busy} title="One good title at random from these filters" onClick={() => void surprise.next()}>
            Surprise me
          </Button>
          <SaveRow source={source} suggested={describe(filters, { provider: providerName })} />
          {modeSwitch}
        </div>
      </header>

      <div className="filterbar" role="group" aria-label="Filters">
        <Segmented
          label="Movies or shows"
          value={kind}
          onChange={(k: Kind) => onChange(withKind(filters, k))}
          options={[
            { value: 'movie', label: 'Movies' },
            { value: 'tv', label: 'Shows' },
          ]}
        />
        <MultiSelect label="Genres (titles that have all of them)" text="Genres" options={genresOf(kind).map((g) => ({ value: g.id, label: g.name }))} values={filters.genres ?? []} onChange={(genres) => set({ genres })} />
        <Select
          label="Released"
          className={`select--compact ${when.value !== 'any' ? 'is-set' : ''}`}
          value={when.value}
          options={when.choices}
          onChange={(v) => set({ from: undefined, to: undefined, recent: undefined, ...setOf(when.choices, v) })}
        />
        <Select label="Rating" className={`select--compact ${rating.value !== 'any' ? 'is-set' : ''}`} value={rating.value} options={rating.choices} onChange={(v) => set({ rating: undefined, ...setOf(rating.choices, v) })} />
        {/* A running time is a film's: shows are told apart by seasons, which TMDB cannot filter on. */}
        {kind === 'movie' && (
          <Select
            label="Length"
            className={`select--compact ${length.value !== 'any' ? 'is-set' : ''}`}
            value={length.value}
            options={length.choices}
            onChange={(v) => set({ runtimeMin: undefined, runtimeMax: undefined, ...setOf(length.choices, v) })}
          />
        )}
        <Select label="Original language" className={`select--compact ${filters.language ? 'is-set' : ''}`} value={filters.language ?? ''} options={languages} onChange={(v) => set({ language: v || undefined })} />
        <MultiSelect
          label={`Where to watch in ${regionName(region)} (on any of them)`}
          text="Where to watch"
          options={providerOptions}
          values={picked}
          onChange={(next) => set({ providers: next, region })}
          onOpen={() => setOpened(true)}
          header={
            <div className="popover__field">
              <span>Country</span>
              <Select label="Country" className="select--compact" value={region} options={regionOptions} onChange={changeRegion} />
            </div>
          }
          note={
            providers.isLoading ? (
              'Loading services…'
            ) : providers.isError ? (
              <>
                TMDB did not answer.{' '}
                <button className="row__more" onClick={() => void providers.refetch()}>
                  Try again
                </button>
              </>
            ) : (
              `TMDB lists no services for ${regionName(region)}.`
            )
          }
        />
        {narrowed && (
          <Button variant="ghost" size="sm" icon={<RotateCcw size={15} />} onClick={reset}>
            Reset
          </Button>
        )}
        <span className="spacer" />
        <Select label="Order" className="select--compact" value={filters.sort ?? 'popular'} options={SORT_CHOICES} onChange={(v) => set({ sort: undefined, ...setOf(SORT_CHOICES, v) })} />
      </div>

      <div className="filterline">
        <span className="filterline__count" role="status">
          {total !== undefined ? countLabel(total, kind) : totals.isError ? '' : 'Counting…'}
        </span>
        {chips.map((c) => (
          <span key={c.key} className="chip chip--sm is-on chip--removable">
            {c.label}
            <button aria-label={`Remove ${c.label}`} title="Remove" onClick={() => onChange(c.without)}>
              <X size={12} />
            </button>
          </span>
        ))}
      </div>

      <section className="starts" aria-label="Starting points">
        <h2 className="eyebrow">Starting points</h2>
        <div className="tiles tiles--row">
          {presetsFor(kind).map((p) => {
            const Icon = PRESET_ICON[p.id];
            const on = preset?.id === p.id;
            // Pressing the one in force takes it off again, where to watch aside.
            return <Tile key={p.id} name={p.name} blurb={p.blurb} icon={<Icon size={18} />} on={on} onClick={() => onChange(on ? normalize({ kind: filters.kind, providers: filters.providers, region: filters.region }) : applyPreset(filters, p))} />;
          })}
        </div>
      </section>

      {surprise.pick && (
        <Featured key={hitKey(surprise.pick)} hit={surprise.pick} label="Surprise pick" active={screen.active}>
          <Button data-nav variant="secondary" size="lg" icon={<Dices size={18} />} busy={surprise.busy} onClick={() => void surprise.next()}>
            Another one
          </Button>
          <IconButton data-nav label="Close the pick" size="lg" onClick={surprise.close}>
            <X size={20} />
          </IconButton>
        </Featured>
      )}

      <div className="page-body">
        {q.isLoadingError ? (
          <LoadFailed title="Discover did not load" onRetry={() => void q.refetch()}>
            TMDB did not answer.
          </LoadFailed>
        ) : q.isSuccess && items.length === 0 ? (
          <Empty
            title="Nothing matches all of that"
            action={
              narrowed && (
                <Button variant="secondary" icon={<RotateCcw size={16} />} onClick={reset}>
                  Reset filters
                </Button>
              )
            }
          >
            {chips.length > 1 ? 'Take a filter away with the × on it above, or start over.' : 'Try a wider filter, or start over.'}
          </Empty>
        ) : (
          <>
            {/* Not for a hidden Discover: it keeps what it has, and asks for no further pages. */}
            <PosterGrid items={items} {...pages} loading={pages.loading || (!q.data && !q.isError)} hasMore={pages.hasMore && screen.active} />
            {!q.hasNextPage && items.length >= GRID_REACH && total !== undefined && total > items.length && (
              <p className="load-more">
                These are the first {items.length} of {countLabel(total, kind).toLowerCase()}. Narrow the filters to reach the rest.
              </p>
            )}
          </>
        )}
      </div>
    </>
  );
}
