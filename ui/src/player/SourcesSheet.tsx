import { useEffect, useMemo, useState } from 'react';
import { Copy, ExternalLink, Play, Zap, AlertTriangle, Loader2, Server } from 'lucide-react';
import { isServerStream } from '../servers';
import type { SourcedStream } from '../addons/types';
import { badges, isPlayable } from '../sources/select';
import { chooseStream, closePicker, usePlayback } from './session';
import { Button, Sheet, Empty } from '../ui/controls';
import { navigate } from '../nav/router';
import { toast } from '../ui/toast';
import { mpv, send } from '../bridge';
import { useSettings } from '../state/settings';

const RES_ORDER = ['4K', '1440p', '1080p', '720p', '480p'];

/** The list of sources for a video, as the addons return them. */
export function SourcesSheet() {
  const picker = usePlayback((s) => s.picker);
  const [res, setRes] = useState<string>('all');
  const [addon, setAddon] = useState<string>('all');
  const externalPlayer = useSettings((s) => s.settings.sources.externalPlayer);

  // A filter belongs to the video it was set for: the next title may not have that resolution or addon.
  const videoId = picker?.target.videoId;
  useEffect(() => {
    setRes('all');
    setAddon('all');
  }, [videoId]);

  const streams = picker?.streams ?? [];
  const playable = useMemo(() => streams.filter(isPlayable), [streams]);
  const withBadges = useMemo(() => playable.map((s) => ({ s, b: badges(s) })), [playable]);
  const resolutions = RES_ORDER.filter((r) => withBadges.some((x) => x.b.resolution === r));
  const addons = [...new Set(playable.map((s) => s.addonName))];
  // A filter whose chip is not on screen (the list changed under it) must not hide everything.
  const resOn = resolutions.length > 1 && resolutions.includes(res) ? res : 'all';
  const addonOn = addons.length > 1 && addons.includes(addon) ? addon : 'all';
  const shown = withBadges.filter((x) => (resOn === 'all' || x.b.resolution === resOn) && (addonOn === 'all' || x.s.addonName === addonOn));
  const unplayable = streams.length - playable.length;

  if (!picker) return null;
  const t = picker.target;
  const subtitle = t.type === 'series' && t.season !== undefined ? `S${t.season} E${t.episode}${t.episodeTitle ? ` · ${t.episodeTitle}` : ''}` : undefined;

  return (
    <Sheet
      open
      onClose={closePicker}
      title={picker.switching ? 'Switch source' : t.name}
      subtitle={
        <span className="sources__subtitle">
          {subtitle && <span>{subtitle}</span>}
          <span>
            {picker.pending > 0 ? (
              <>
                <Loader2 size={13} className="spin" /> Asking {picker.pending} addon{picker.pending > 1 ? 's' : ''}…
              </>
            ) : (
              `${playable.length} source${playable.length === 1 ? '' : 's'}`
            )}
          </span>
        </span>
      }
      width={640}
    >
      {(resolutions.length > 1 || addons.length > 1) && (
        <div className="sources__filters">
          {resolutions.length > 1 && (
            <div className="chips" role="radiogroup" aria-label="Resolution">
              {['all', ...resolutions].map((r) => (
                <button key={r} role="radio" aria-checked={resOn === r} className={`chip chip--sm ${resOn === r ? 'is-on' : ''}`} onClick={() => setRes(r)}>
                  {r === 'all' ? 'All' : r}
                </button>
              ))}
            </div>
          )}
          {addons.length > 1 && (
            <div className="chips" role="radiogroup" aria-label="Addon">
              {['all', ...addons].map((a) => (
                <button key={a} role="radio" aria-checked={addonOn === a} className={`chip chip--sm ${addonOn === a ? 'is-on' : ''}`} onClick={() => setAddon(a)}>
                  {a === 'all' ? 'Every addon' : a}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {!picker.noAddon && picker.errors.map((e) => (
        <p key={e} className="sources__error">
          <AlertTriangle size={14} /> {e}
        </p>
      ))}

      {picker.noAddon && (
        <Empty title="No stream addon installed" action={<Button variant="primary" onClick={() => (closePicker(), navigate({ name: 'settings', section: 'addons' }))}>Open addons</Button>}>
          Add a stream addon such as AIOStreams to play titles.
        </Empty>
      )}
      {!picker.noAddon && shown.length === 0 && picker.pending === 0 && (
        <Empty title="No sources found">{unplayable > 0 ? 'The addons answered, but none of their results can be played here.' : 'Your stream addons did not return anything for this one. Try again later or check the addon.'}</Empty>
      )}
      {shown.length === 0 && picker.pending > 0 && (
        <div className="sources__loading">
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i} className="skeleton sources__skeleton" />
          ))}
        </div>
      )}

      <ul className="sources__list">
        {shown.map(({ s, b }, i) => (
          <SourceRow key={`${s.addonId}-${s.rank}-${i}`} s={s} b={b} externalPlayer={externalPlayer} />
        ))}
      </ul>
    </Sheet>
  );
}

function SourceRow({ s, b, externalPlayer }: { s: SourcedStream; b: ReturnType<typeof badges>; externalPlayer: string }) {
  const lines = (s.description ?? s.title ?? '').split('\n').filter((l) => l.trim());
  const name = (s.name ?? s.addonName).split('\n');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(s.url!);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy the link');
    }
  };
  const openExternal = () => {
    // Two players at once would talk over each other.
    if (usePlayback.getState().session) mpv.set('pause', true);
    // The shell answers with whether the program started; App shows that.
    send({ t: 'open-external-player', url: s.url!, player: externalPlayer });
  };
  return (
    <li className="source">
      <button className="source__main" onClick={() => chooseStream(s)}>
        <span className="source__name">
          {name.map((n, i) => (
            <span key={i}>{n}</span>
          ))}
        </span>
        <span className="source__body">
          <span className="source__badges">
            {isServerStream(s) && (
              <span className="badge badge--accent">
                <Server size={11} /> Your server
              </span>
            )}
            {b.cached && (
              <span className="badge badge--accent">
                <Zap size={11} fill="currentColor" strokeWidth={0} /> Cached
              </span>
            )}
            {b.resolution && <span className="badge">{b.resolution}</span>}
            {b.hdr && <span className="badge badge--hdr">{b.hdr}</span>}
            {b.remux && <span className="badge">REMUX</span>}
            {b.codec && <span className="badge">{b.codec}</span>}
            {b.audio && <span className="badge">{b.audio}</span>}
            {b.size && <span className="badge badge--plain">{b.size}</span>}
            {b.service && <span className="badge badge--plain">{b.service}</span>}
          </span>
          {lines.length > 0 && (
            <span className="source__desc">
              {lines.slice(0, 6).map((l, i) => (
                <span key={i}>{l}</span>
              ))}
            </span>
          )}
        </span>
        <span className="source__play" aria-hidden>
          <Play size={16} fill="currentColor" strokeWidth={0} />
        </span>
      </button>
      <div className="source__side">
        <button className="ibtn ibtn--sm" aria-label="Copy link" title="Copy link" onClick={() => void copy()}>
          <Copy size={15} />
        </button>
        {externalPlayer && (
          <button className="ibtn ibtn--sm" aria-label="Open in external player" title="Open in external player" onClick={openExternal}>
            <ExternalLink size={15} />
          </button>
        )}
      </div>
    </li>
  );
}
