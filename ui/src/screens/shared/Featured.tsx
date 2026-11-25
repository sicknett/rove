// One title given the stage: Search's best match and Discover's "Surprise me". Backdrop, the
// facts that help decide, and the three things to do about it. It is drawn once per screen, so it
// can afford a picture this size; the dark side behind the text is a plain gradient.

import { Check, Info, Play, Plus, Star } from 'lucide-react';
import { useTmdb } from '../../data/hooks';
import { toggleWatchlist, useInWatchlist } from '../../library/watchlist';
import { navigate } from '../../nav/router';
import { playTitle } from '../../player/launch';
import { Img } from '../../ui/Img';
import { Button, IconButton } from '../../ui/controls';
import { genreNames } from './genres';
import { hitImage, type PersonHit, type TitleHit } from './hits';

function runtimeText(minutes: number | undefined): string | undefined {
  if (!minutes || minutes < 1) return undefined;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

interface Props {
  hit: TitleHit;
  /** What this title is here as: "Best match", "Surprise pick". */
  label: string;
  /**
   * The screen is the one on show. Hidden screens stay mounted, and one that is hidden does not
   * ask TMDB for the running time and certificate.
   */
  active: boolean;
  /** More buttons after the usual three ("Another one"). */
  children?: React.ReactNode;
}

export function Featured({ hit, label, active, children }: Props) {
  const metaId = `tmdb:${hit.tmdbId}`;
  // One request, and the same one the title's own page makes: opening it afterwards is instant.
  const more = useTmdb(hit.type, active ? metaId : undefined).data;
  const inList = useInWatchlist(metaId, hit.type);
  const poster = hitImage(hit.poster, 'w342');
  const backdrop = hitImage(hit.backdrop, 'w1280');
  const card = { metaId, type: hit.type, name: hit.name, poster, background: backdrop, year: hit.year };
  const details = more?.details;
  const length = hit.kind === 'movie' ? runtimeText(details?.runtime) : details?.number_of_seasons ? `${details.number_of_seasons} ${details.number_of_seasons === 1 ? 'season' : 'seasons'}` : undefined;
  const genres = genreNames(hit.kind, hit.genres);
  return (
    <section className={`feature ${backdrop ? '' : 'feature--poster'}`} aria-label={`${label}: ${hit.name}`}>
      <Img src={backdrop ?? poster} alt="" className="feature__img" loading="eager" />
      <div className="feature__shade" />
      <div className="feature__body">
        <p className="eyebrow feature__label">{label}</p>
        <h2 className="feature__title">{hit.name}</h2>
        <div className="hero__meta">
          {hit.rating > 0 && (
            <span className="hero__rating">
              <Star size={13} fill="currentColor" strokeWidth={0} /> {hit.rating.toFixed(1)}
            </span>
          )}
          <span>{hit.kind === 'movie' ? 'Movie' : 'Show'}</span>
          {hit.year && <span>{hit.year}</span>}
          {more?.certification && <span className="tag">{more.certification}</span>}
          {length && <span>{length}</span>}
          {genres.map((g) => (
            <span key={g}>{g}</span>
          ))}
        </div>
        {hit.overview && <p className="feature__overview">{hit.overview}</p>}
        <div className="feature__actions">
          <Button data-nav variant="primary" size="lg" icon={<Play size={18} fill="currentColor" strokeWidth={0} />} onClick={() => void playTitle(hit.type, metaId, card)}>
            Play
          </Button>
          <Button data-nav variant="secondary" size="lg" icon={<Info size={18} />} onClick={() => navigate({ name: 'title', type: hit.type, id: metaId })}>
            Details
          </Button>
          <IconButton data-nav label={inList ? 'Remove from Watchlist' : 'Add to Watchlist'} size="lg" className="ibtn--glass" active={inList} onClick={() => void toggleWatchlist(card)}>
            {inList ? <Check size={20} /> : <Plus size={20} />}
          </IconButton>
          {children}
        </div>
      </div>
    </section>
  );
}

/** A person as the best match: who they are, what they are known for, and the way to their page. */
export function FeaturedPerson({ person, label }: { person: PersonHit; label: string }) {
  const open = () => navigate({ name: 'person', id: person.id, label: person.name });
  return (
    <section className="feature feature--person" aria-label={`${label}: ${person.name}`}>
      <Img src={hitImage(person.photo, 'w342')} alt="" className="feature__face" loading="eager" fallback={<span className="feature__face feature__face--mono">{person.name[0]}</span>} />
      <div className="feature__body">
        <p className="eyebrow feature__label">{label}</p>
        <h2 className="feature__title">{person.name}</h2>
        <div className="hero__meta">
          {person.department && <span>{person.department}</span>}
          {person.knownFor.length > 0 && <span>Known for {person.knownFor.map((k) => k.name).join(', ')}</span>}
        </div>
        <div className="feature__actions">
          <Button data-nav variant="primary" size="lg" onClick={open}>
            See their work
          </Button>
        </div>
      </div>
    </section>
  );
}
