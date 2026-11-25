// The cards Search and Discover lay out besides the poster grid: a title from a catalog card, a
// person, and the flat tiles that stand for a genre or a ready-made filter set.

import type { MetaPreview } from '../../addons/types';
import { asMediaType } from '../../data/hooks';
import { PosterCard } from '../../media/cards';
import { navigate } from '../../nav/router';
import { Img } from '../../ui/Img';
import { Skeleton } from '../../ui/controls';
import { hitImage, type PersonHit } from './hits';

/** A catalog card as a poster card: the one mapping the poster grid uses, for rows. */
export function PreviewCard({ m, subtitle, progress }: { m: MetaPreview; subtitle?: string; progress?: number }) {
  return <PosterCard title={{ metaId: m.id, type: asMediaType(m.type), name: m.name, poster: m.poster, background: m.background, logo: m.logo, year: m.releaseInfo, rating: m.imdbRating }} subtitle={subtitle} progress={progress} />;
}

/** A person, as the cast on a title's page is drawn. Opens their page. */
export function PersonCard({ person }: { person: PersonHit }) {
  // What they do, and failing that the title most people know them from.
  const role = person.department && person.department !== 'Acting' ? person.department : person.knownFor[0]?.name ?? person.department;
  return (
    <button className="person" onClick={() => navigate({ name: 'person', id: person.id, label: person.name })}>
      <Img src={hitImage(person.photo, 'w185')} alt="" className="person__img" fallback={<span className="person__mono">{person.name[0]}</span>} />
      <span className="person__name">{person.name}</span>
      {role && (
        <span className="person__role" title={role}>
          {role}
        </span>
      )}
    </button>
  );
}

/** Placeholders the shape of people, while they load. */
export function PeopleSkeleton({ count = 8 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="person" aria-hidden>
          <Skeleton className="person__img" />
          <Skeleton className="card__caption-skeleton" />
        </div>
      ))}
    </>
  );
}

interface TileProps {
  name: string;
  blurb?: string;
  icon?: React.ReactNode;
  on?: boolean;
  /** A hue, 0 to 360, for a tile that is told apart by its colour (genres). Without it the tile is neutral. */
  hue?: number;
  onClick: () => void;
}

/** A flat tile: a name, perhaps a line under it, one click. */
export function Tile({ name, blurb, icon, on, hue, onClick }: TileProps) {
  return (
    <button data-nav className={`tile ${on ? 'is-on' : ''} ${hue !== undefined ? 'tile--tint' : ''}`} style={hue !== undefined ? { ['--tile-h' as string]: hue } : undefined} aria-pressed={on} onClick={onClick}>
      {icon && <span className="tile__icon">{icon}</span>}
      <span className="tile__text">
        <span className="tile__name">{name}</span>
        {blurb && <span className="tile__blurb">{blurb}</span>}
      </span>
    </button>
  );
}
