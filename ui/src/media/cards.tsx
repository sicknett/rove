import { tmdbResized } from '../meta/tmdb';
import { memo, useContext, useRef, useState } from 'react';
import { Check, Play, Star } from 'lucide-react';
import { Img } from '../ui/Img';
import { ProgressLine, type MenuItem } from '../ui/controls';
import { navigate } from '../nav/router';
import { openContextMenu } from '../ui/contextmenu';
import { titleMenu, type CardTitle } from './actions';
import { useHistory } from '../state/history';
import { useSettings } from '../state/settings';
import { useInWatchlist } from '../library/watchlist';
import { canonicalNow } from '../tracking/idmap';
import { formatTime } from '../format';
import { playTitle } from '../player/launch';
import { CardPreview, type PreviewState } from './CardPreview';
import { RowContext } from './Row';
import { armPreview, disarmPreview, previewArt, previewsOn } from './preview';

function Monogram({ name }: { name?: string }) {
  return (
    <span className="card__monogram" aria-hidden>
      {name?.trim()?.[0]?.toUpperCase() ?? '?'}
    </span>
  );
}

interface PosterProps {
  title: CardTitle & { rating?: string | number };
  /** 0..1 */
  progress?: number;
  onPlay?: () => void;
  /** The line under the name. Without it the year shows there. */
  subtitle?: string;
  /**
   * Set for a Continue Watching card (its history key): the poster then plays instead of opening
   * the title page (the name below still opens it), and the menu offers Remove and Mark watched.
   */
  continueKey?: string;
  season?: number;
  episode?: number;
  /** More entries for the card's menu, after the usual ones (a recommendation's "Not interested"). Asked for when the menu opens. */
  menuExtra?: () => (MenuItem | 'divider')[];
}

/**
 * A 2:3 poster with title below; watched tick and progress when known. In a row (media/Row) it
 * opens into a preview with the title's trailer when the pointer rests on it; in a grid, with
 * the setting off or with motion reduced, it does not.
 */
export const PosterCard = memo(function PosterCard({ title, progress, onPlay, subtitle, continueKey, season, episode, menuExtra }: PosterProps) {
  const row = useContext(RowContext);
  const root = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<PreviewState>('closed');
  // Where on the screen the pointer was when the preview opened: the row keeps the card under it.
  const [openedAt, setOpenedAt] = useState(0);
  // History keeps a title under its IMDb id when that is known; a card may carry its `tmdb:` id.
  const watched = useHistory((s) => title.type === 'movie' && !!s.watched[canonicalNow(title.metaId, 'movie')]);
  const inList = useInWatchlist(title.metaId, title.type);
  const showRatings = useSettings((s) => s.settings.appearance.showRatings);
  const rating = Number(title.rating);
  const open = () => navigate({ name: 'title', type: title.type, id: title.metaId });
  const plays = !!continueKey && !!onPlay;
  const sub = subtitle ?? (title.year ? String(title.year).slice(0, 9) : undefined);
  // The pointer has come onto the poster: it opens if it rests there (preview.ts). Not for a
  // touch, nor with a button held (a drag passing over). Focus does not open it: that would
  // fire all along a row being tabbed through.
  const arm = (e: React.PointerEvent<HTMLElement>) => {
    if (preview === 'open' || e.pointerType === 'touch' || e.buttons || !previewsOn()) return;
    armPreview(
      e.currentTarget,
      e.clientX,
      (pointerX) => {
        setOpenedAt(pointerX);
        setPreview('open');
      },
      () => {
        const art = previewArt(title.background);
        if (art) new Image().src = art;
      },
    );
  };
  const leave = () => {
    disarmPreview();
    if (preview === 'open') setPreview('closing');
  };
  return (
    <div
      ref={root}
      className={`card card--poster${preview !== 'closed' ? ' card--preview' : ''}${preview === 'open' ? ' is-expanded' : ''}`}
      onContextMenu={(e) => openContextMenu(e, [...titleMenu(title, { onPlay, continueKey, season, episode }), ...(menuExtra?.() ?? [])])}
      onPointerLeave={row ? leave : undefined}
    >
      <button
        className="card__frame"
        onClick={plays ? onPlay : open}
        aria-label={plays ? `Play ${title.name ?? ''} ${subtitle ?? ''}` : title.name}
        onPointerEnter={row ? arm : undefined}
        onPointerLeave={row ? disarmPreview : undefined}
        onPointerDown={row ? disarmPreview : undefined}
      >
        <Img src={title.poster} alt="" className="card__img" fallback={<Monogram name={title.name} />} />
        <span className="card__shine" aria-hidden />
        {watched && (
          <span className="card__badge card__badge--watched" title="Watched">
            <Check size={13} strokeWidth={3} />
          </span>
        )}
        {inList && !watched && <span className="card__badge card__badge--list" title="On your Watchlist" />}
        {showRatings && rating > 0 && (
          <span className="card__rating">
            <Star size={11} fill="currentColor" strokeWidth={0} /> {rating.toFixed(1)}
          </span>
        )}
        {progress !== undefined && progress > 0 && (
          <span className="card__progress">
            <ProgressLine value={progress} />
          </span>
        )}
      </button>
      {/* Over the frame, not in it: it has buttons of its own. A click on the picture still reaches the frame. */}
      {row && preview !== 'closed' && (
        <CardPreview title={title} card={root} row={row} pointerX={openedAt} inList={inList} closing={preview === 'closing'} onPlay={onPlay ?? (() => void playTitle(title.type, title.metaId, title))} onState={setPreview} />
      )}
      <div className="card__caption">
        {plays ? (
          <button className="card__name card__name--link" onClick={open} title={title.name}>
            {title.name ?? subtitle}
          </button>
        ) : (
          <span className="card__name" title={title.name}>
            {title.name}
          </span>
        )}
        {sub && (title.name || !plays) && (
          <span className="card__sub" title={subtitle}>
            {sub}
          </span>
        )}
      </div>
    </div>
  );
});

interface WideProps {
  title: CardTitle;
  image?: string;
  subtitle?: string;
  progress?: number;
  remainingS?: number;
  continueKey?: string;
  season?: number;
  episode?: number;
  onPlay: () => void;
}

/** A 16:9 card for Continue Watching: art, logo or name, what's next, progress. */
export const WideCard = memo(function WideCard({ title, image, subtitle, progress, remainingS, continueKey, season, episode, onPlay }: WideProps) {
  const open = () => navigate({ name: 'title', type: title.type, id: title.metaId });
  return (
    <div className="card card--wide" onContextMenu={(e) => openContextMenu(e, titleMenu(title, { onPlay, continueKey, season, episode }))}>
      <button className="card__frame" onClick={onPlay} aria-label={`Play ${title.name ?? ''} ${subtitle ?? ''}`}>
        <Img src={tmdbResized(image ?? title.background ?? title.poster, 'w780')} alt="" className="card__img" fallback={<Monogram name={title.name} />} />
        <span className="card__scrim" aria-hidden />
        <span className="card__wide-text">
          {title.logo ? <Img src={title.logo} alt={title.name} className="card__logo" fallback={<span className="card__wide-name">{title.name}</span>} /> : <span className="card__wide-name">{title.name}</span>}
        </span>
        <span className="card__play" aria-hidden>
          <Play size={20} fill="currentColor" strokeWidth={0} />
        </span>
        {progress !== undefined && progress > 0 && (
          <span className="card__progress">
            <ProgressLine value={progress} />
          </span>
        )}
      </button>
      <div className="card__caption card__caption--wide">
        <button className="card__name card__name--link" onClick={open} title={title.name}>
          {title.name ?? subtitle}
        </button>
        <span className="card__sub">{[title.name ? subtitle : undefined, remainingS !== undefined && remainingS > 0 ? formatRemaining(remainingS) : undefined].filter(Boolean).join(' · ')}</span>
      </div>
    </div>
  );
});

export function formatRemaining(s: number) {
  if (s < 60) return 'Almost done';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min left`;
  return `${Math.floor(m / 60)} h ${m % 60} min left`;
}

export { formatTime };
