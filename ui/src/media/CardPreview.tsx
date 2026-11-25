// What a poster in a row opens into when the pointer rests on it (cards.tsx decides when): the
// card widens to a 16:9 picture of the same height, showing the title's backdrop, then its
// trailer over that, with its logo, a line of facts and the things to do with it.
//
// It exists for the one open card only. Everything it needs (TMDB's answer, the trailer's frame,
// the listener that closes it when the page scrolls) starts here and goes when it closes.

import { useEffect, useLayoutEffect, useState } from 'react';
import { Check, Info, Play, Plus, Volume2, VolumeX } from 'lucide-react';
import { useTmdb } from '../data/hooks';
import { toggleWatchlist } from '../library/watchlist';
import { navigate, useScreen } from '../nav/router';
import { Button, IconButton } from '../ui/controls';
import { Img } from '../ui/Img';
import type { CardTitle } from './actions';
import type { RowHost } from './Row';
import { TrailerFrame } from './TrailerFrame';
import { claimPreview, EXPAND_MS, EXPAND_RATIO, previewArt, previewFacts } from './preview';

export type PreviewState = 'closed' | 'open' | 'closing';

interface Props {
  title: CardTitle;
  /** The card: the element that widens. */
  card: React.RefObject<HTMLDivElement | null>;
  row: RowHost;
  /** Where on the screen the pointer was when the card opened. */
  pointerX: number;
  inList: boolean;
  /** The card is on its way back to a poster: the picture fades and the trailer is gone. */
  closing: boolean;
  onPlay: () => void;
  /** Moves the card on: 'closing' to start closing, 'closed' once it is a poster again. */
  onState: (state: PreviewState) => void;
}

export function CardPreview({ title, card, row, pointerX, inList, closing, onPlay, onState }: Props) {
  const tmdb = useTmdb(title.type, title.metaId);
  const { active } = useScreen();
  // The card has finished widening: only then is the trailer's frame made, so loading it never
  // falls on the frames in which the row is moving.
  const [settled, setSettled] = useState(false);
  // One trailer per opening: one that ended, or never started, leaves the backdrop showing.
  const [trailerOver, setTrailerOver] = useState(false);

  // One preview at a time, app-wide.
  useEffect(() => claimPreview(() => onState('closing')), [onState]);

  // The row makes room (and keeps its arrows and snapping out of the way) while this is open.
  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    if (closing) return row.settle('closing');
    row.expand(el, parseFloat(getComputedStyle(el).getPropertyValue('--card-w')) * EXPAND_RATIO, pointerX);
  }, [closing, card, row, pointerX]);
  useEffect(() => () => row.settle('closed'), [row]);

  useEffect(() => {
    if (closing) setSettled(false);
    const t = window.setTimeout(() => (closing ? onState('closed') : setSettled(true)), EXPAND_MS + 60);
    return () => window.clearTimeout(t);
  }, [closing, onState]);

  // The page scrolling takes the card from under the pointer, and no "leave" comes until the
  // pointer next moves: it closes at once instead. So does going behind another screen or the
  // player (Play, Details, a click on the picture).
  useEffect(() => {
    const screen = card.current?.closest('.screen');
    const close = () => onState('closing');
    screen?.addEventListener('scroll', close, { passive: true });
    return () => screen?.removeEventListener('scroll', close);
  }, [card, onState]);
  useEffect(() => {
    if (!active) onState('closing');
  }, [active, onState]);

  const art = previewArt(title.background, tmdb.data);
  const logo = title.logo ?? tmdb.data?.logo;
  const facts = previewFacts(title, tmdb.data);
  const trailerId = tmdb.data?.trailer;
  const name = <span className="preview__name">{title.name}</span>;

  return (
    <div className={`preview${closing ? ' is-closing' : ''}`}>
      <Img src={art} alt="" className="preview__art" loading="eager" />
      {settled && !closing && trailerId && !trailerOver && (
        <TrailerFrame
          id={trailerId}
          name={title.name ?? ''}
          paused={false}
          solo
          className="preview__trailer"
          onEnded={() => setTrailerOver(true)}
          controls={({ sound, toggleSound }) => (
            <IconButton label={sound ? 'Mute the trailer' : 'Turn the trailer sound on'} size="sm" className="ibtn--glass preview__sound" onClick={toggleSound}>
              {sound ? <Volume2 size={16} /> : <VolumeX size={16} />}
            </IconButton>
          )}
        />
      )}
      <span className="preview__shade" aria-hidden />
      <div className="preview__body">
        {/* The logo and the facts come with TMDB's answer; they arrive together, not one by one. */}
        {!tmdb.isLoading && (
          <div className="preview__text">
            {logo ? <Img src={logo} alt={title.name} className="preview__logo" loading="eager" fallback={name} /> : name}
            <div className="preview__facts">
              {facts.year && <span>{facts.year}</span>}
              {facts.certification && <span className="preview__cert">{facts.certification}</span>}
              {facts.length && <span>{facts.length}</span>}
              {facts.genres.length > 0 && <span className="preview__genres">{facts.genres.join(', ')}</span>}
            </div>
          </div>
        )}
        <div className="preview__actions">
          <Button variant="primary" size="sm" icon={<Play size={14} fill="currentColor" strokeWidth={0} />} onClick={onPlay}>
            Play
          </Button>
          <IconButton label={inList ? 'Remove from Watchlist' : 'Add to Watchlist'} size="sm" className="ibtn--glass" active={inList} onClick={() => void toggleWatchlist(title)}>
            {inList ? <Check size={16} /> : <Plus size={16} />}
          </IconButton>
          <IconButton label="Details" size="sm" className="ibtn--glass" onClick={() => navigate({ name: 'title', type: title.type, id: title.metaId })}>
            <Info size={16} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
