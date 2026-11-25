// Search before anything is typed: what was searched for lately, what is trending, genres to
// jump into Discover with, and people in the news. Two requests (trending titles, trending
// people), both kept for hours; the genres are a list in the app and cost none.

import { useState } from 'react';
import { Brush, Camera, Clock, Compass, Drama, Fingerprint, Ghost, Heart, Landmark, Laugh, Mountain, Music, Newspaper, Rocket, Search as SearchIcon, Shield, Siren, Smile, Swords, Tv, Users, WandSparkles, X, Zap } from 'lucide-react';
import { Row, RowRetry } from '../../media/Row';
import { navigate } from '../../nav/router';
import { Button, Empty, Segmented } from '../../ui/controls';
import { discoverRoute } from '../discover/filters';
import { PeopleSkeleton, PersonCard, PreviewCard, Tile } from '../shared/cards';
import { genresOf, type Kind } from '../shared/genres';
import { hitKey, hitPreview, kidSafe } from '../shared/hits';
import { useTrending } from './data';

const GENRE_ICON: Record<number, typeof Swords> = {
  28: Swords,
  12: Compass,
  16: Brush,
  35: Laugh,
  80: Siren,
  99: Camera,
  18: Drama,
  10751: Users,
  14: WandSparkles,
  36: Landmark,
  27: Ghost,
  10402: Music,
  9648: Fingerprint,
  10749: Heart,
  878: Rocket,
  53: Zap,
  10752: Shield,
  37: Mountain,
  10759: Swords,
  10762: Smile,
  10763: Newspaper,
  10764: Tv,
  10765: Rocket,
  10768: Shield,
};

/** Genres nobody browses by: a TV movie is a format, and talk and soap are daily programmes. */
const NOT_TILES = new Set([10770, 10766, 10767]);

interface Props {
  /** Search is the screen on show, with nothing typed: only then is anything asked for. */
  active: boolean;
  hasKey: boolean;
  /** Something can be searched at all: a TMDB key, or an addon or server with search. */
  canSearch: boolean;
  kids: boolean;
  recent: string[];
  onPick: (text: string) => void;
  onRemove: (text: string) => void;
  onClear: () => void;
}

export function Landing({ active, hasKey, canSearch, kids, recent, onPick, onRemove, onClear }: Props) {
  const [kind, setKind] = useState<Kind>('movie');
  const { titles, people } = useTrending(active && hasKey);
  // /trending cannot be asked for family titles only, so a Kids profile sees the ones that are.
  const trending = (titles.data ?? []).filter((h) => h.poster && (!kids || kidSafe(h)));
  const genres = genresOf(kind).filter((g) => !NOT_TILES.has(g.id));

  return (
    <>
      {recent.length > 0 && (
        <section className="recent-searches">
          <header className="section-head">
            <h2 className="eyebrow">Recent searches</h2>
            <button className="row__more" onClick={onClear}>
              Clear all
            </button>
          </header>
          <div className="chips">
            {recent.map((r) => (
              <span key={r} className="chip chip--split">
                <button data-nav className="chip__main" title={r} onClick={() => onPick(r)}>
                  <Clock size={13} /> <span className="chip__text">{r}</span>
                </button>
                <button className="chip__x" aria-label={`Remove ${r} from recent searches`} title="Remove" onClick={() => onRemove(r)}>
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
        </section>
      )}

      {!hasKey && (
        <Empty
          icon={<SearchIcon size={36} />}
          title={canSearch ? 'Search your addons by name' : 'Nothing can search yet'}
          action={
            <Button variant="secondary" onClick={() => navigate({ name: 'settings', section: canSearch ? 'accounts' : 'addons' })}>
              {canSearch ? 'Open Accounts' : 'Open Addons'}
            </Button>
          }
        >
          {canSearch
            ? 'Trending titles, people, genres and the best match come from TMDB, and there is no TMDB key. Add one in Settings → Accounts to get the rest of this page.'
            : 'Add a metadata addon with search (AIOMetadata can) in Settings → Addons, or a TMDB key in Settings → Accounts.'}
        </Empty>
      )}

      {hasKey && (titles.isLoading || titles.isError || trending.length > 0) && (
        <Row title="Trending now" loading={titles.isLoading}>
          {titles.isError && <RowRetry onRetry={() => void titles.refetch()}>Trending did not load.</RowRetry>}
          {trending.map((h) => (
            <PreviewCard key={hitKey(h)} m={hitPreview(h)} />
          ))}
        </Row>
      )}

      {hasKey && (
        <section className="search-block">
          <header className="section-head">
            <h2 className="row__title">Browse by genre</h2>
            <Segmented
              label="Genres of"
              value={kind}
              onChange={setKind}
              options={[
                { value: 'movie', label: 'Movies' },
                { value: 'tv', label: 'Shows' },
              ]}
            />
          </header>
          <div className="tiles">
            {genres.map((g, i) => {
              const Icon = GENRE_ICON[g.id] ?? Compass;
              // The golden angle between neighbours: no two tiles side by side share a colour.
              return <Tile key={g.id} name={g.name} hue={Math.round((i * 137.5 + 150) % 360)} icon={<Icon size={18} />} onClick={() => navigate(discoverRoute({ kind: kind === 'tv' ? 'tv' : undefined, genres: [g.id] }))} />;
            })}
          </div>
        </section>
      )}

      {hasKey && !kids && (people.isLoading || (people.data?.length ?? 0) > 0) && (
        <Row title="Popular people this week">
          {people.isLoading && <PeopleSkeleton />}
          {(people.data ?? []).map((p) => (
            <PersonCard key={p.id} person={p} />
          ))}
        </Row>
      )}
    </>
  );
}
