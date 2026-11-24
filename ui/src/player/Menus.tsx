import { Check, Minus, Plus } from 'lucide-react';
import { mpv } from '../bridge';
import { channelLabel, languageName } from '../format';
import { useSettings } from '../state/settings';
import { usePlayback } from './session';
import { rememberChoice } from './runtime';
import { usePlayer, type Track } from './store';

export const AUDIO_DELAY_MIN_MS = -500;
export const AUDIO_DELAY_MAX_MS = 1500;
const STEP_MS = 50;

function trackLabel(t: Track, index: number): { main: string; detail: string } {
  const lang = languageName(t.lang);
  const title = t.title?.trim();
  const main = title && title !== lang ? (lang && !title.toLowerCase().includes(lang.toLowerCase()) ? `${lang} · ${title}` : title) : lang ?? `Track ${index + 1}`;
  const parts = [
    t.codec?.toUpperCase().replace('SUBRIP', 'SRT').replace('HDMV_PGS_SUBTITLE', 'PGS'),
    t.type === 'audio' ? channelLabel(t['demux-channel-count'] ?? t['audio-channels']) : null,
    t.forced ? 'Forced' : null,
    t.external ? 'Added' : null,
  ].filter(Boolean);
  return { main, detail: parts.join(' · ') };
}

function Stepper({ value, onChange, unit, label, step }: { value: number; onChange: (v: number) => void; unit: string; label: string; step: number }) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button className="stepper__btn" aria-label={`Less ${label}`} onClick={() => onChange(value - step)}>
        <Minus size={14} />
      </button>
      <span className="stepper__value">
        {value > 0 ? `+${value}` : value} {unit}
      </span>
      <button className="stepper__btn" aria-label={`More ${label}`} onClick={() => onChange(value + step)}>
        <Plus size={14} />
      </button>
    </div>
  );
}

function stop(e: React.PointerEvent) {
  e.stopPropagation();
}

export function AudioMenu() {
  const tracks = usePlayer((s) => s.tracks);
  const aid = usePlayer((s) => s.aid);
  const delayMs = useSettings((s) => s.settings.audio.delayMs);
  const setSettings = useSettings((s) => s.set);
  const audio = tracks.filter((t) => t.type === 'audio');

  const changeDelay = (ms: number) => {
    const clamped = Math.max(AUDIO_DELAY_MIN_MS, Math.min(AUDIO_DELAY_MAX_MS, ms));
    setSettings('audio', { delayMs: clamped });
    mpv.set('audio-delay', clamped / 1000);
  };

  return (
    <div className="menu" role="menu" onPointerDown={stop}>
      <h3 className="menu__heading">Audio</h3>
      {audio.length === 0 && <p className="menu__empty">No audio tracks</p>}
      {audio.map((t, i) => {
        const { main, detail } = trackLabel(t, i);
        const on = aid === t.id;
        return (
          <button
            key={t.id}
            className={`menu__item${on ? ' is-selected' : ''}`}
            role="menuitemradio"
            aria-checked={on}
            onClick={() => {
              mpv.set('aid', t.id);
              rememberChoice(usePlayback.getState().session, 'audio', t.id);
            }}
          >
            <span className="menu__check">{on && <Check size={15} />}</span>
            <span className="menu__label">{main}</span>
            {detail && <span className="menu__detail">{detail}</span>}
          </button>
        );
      })}
      <div className="menu__divider" />
      <div className="menu__row">
        <div className="menu__row-text">
          <span className="menu__label">Audio offset</span>
          <span className="menu__hint">Raise it if sound from Bluetooth headphones runs behind the picture</span>
        </div>
        <Stepper value={delayMs} onChange={changeDelay} unit="ms" label="audio offset" step={STEP_MS} />
      </div>
    </div>
  );
}

export function SubtitleMenu() {
  const tracks = usePlayer((s) => s.tracks);
  const sid = usePlayer((s) => s.sid);
  const subDelay = usePlayer((s) => s.subDelay);
  const size = useSettings((s) => s.settings.subtitleStyle.size);
  const setSettings = useSettings((s) => s.set);
  const subs = tracks.filter((t) => t.type === 'sub');
  const pick = (id: number | 'no') => {
    mpv.set('sid', id);
    rememberChoice(usePlayback.getState().session, 'sub', id);
  };
  const delayMs = Math.round(subDelay * 1000);
  return (
    <div className="menu menu--wide" role="menu" onPointerDown={stop}>
      <h3 className="menu__heading">Subtitles</h3>
      <button className={`menu__item${sid === null ? ' is-selected' : ''}`} role="menuitemradio" aria-checked={sid === null} onClick={() => pick('no')}>
        <span className="menu__check">{sid === null && <Check size={15} />}</span>
        <span className="menu__label">Off</span>
      </button>
      {subs.map((t, i) => {
        const { main, detail } = trackLabel(t, i);
        const on = sid === t.id;
        return (
          <button key={t.id} className={`menu__item${on ? ' is-selected' : ''}`} role="menuitemradio" aria-checked={on} onClick={() => pick(t.id)}>
            <span className="menu__check">{on && <Check size={15} />}</span>
            <span className="menu__label">{main}</span>
            {detail && <span className="menu__detail">{detail}</span>}
          </button>
        );
      })}
      {subs.length === 0 && <p className="menu__empty">No subtitles in this stream, and no subtitle addon found any</p>}
      <div className="menu__divider" />
      <div className="menu__row">
        <div className="menu__row-text">
          <span className="menu__label">Timing</span>
          <span className="menu__hint">Positive shows them later</span>
        </div>
        <Stepper value={delayMs} onChange={(ms) => mpv.set('sub-delay', ms / 1000)} unit="ms" label="subtitle timing" step={100} />
      </div>
      <div className="menu__row">
        <span className="menu__label">Size</span>
        <div className="segmented segmented--sm">
          {[
            { v: 38, l: 'S' },
            { v: 46, l: 'M' },
            { v: 56, l: 'L' },
            { v: 68, l: 'XL' },
          ].map((o) => (
            <button key={o.v} className={`segmented__item ${size === o.v ? 'is-on' : ''}`} onClick={() => setSettings('subtitleStyle', { size: o.v })}>
              {o.l}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export function SpeedMenu() {
  const speed = usePlayer((s) => s.speed);
  return (
    <div className="menu menu--narrow" role="menu" onPointerDown={stop}>
      <h3 className="menu__heading">Speed</h3>
      {SPEEDS.map((v) => {
        const on = Math.abs(speed - v) < 0.001;
        return (
          <button key={v} className={`menu__item${on ? ' is-selected' : ''}`} role="menuitemradio" aria-checked={on} onClick={() => mpv.set('speed', v)}>
            <span className="menu__check">{on && <Check size={15} />}</span>
            <span className="menu__label">{v === 1 ? 'Normal' : `${v}×`}</span>
          </button>
        );
      })}
    </div>
  );
}

const ASPECTS: { id: string; label: string; apply: () => void }[] = [
  { id: 'fit', label: 'Fit', apply: () => (mpv.set('video-aspect-override', 'no'), mpv.set('panscan', 0), mpv.set('video-zoom', 0)) },
  { id: 'fill', label: 'Fill screen', apply: () => (mpv.set('video-aspect-override', 'no'), mpv.set('panscan', 1), mpv.set('video-zoom', 0)) },
  { id: 'zoom', label: 'Zoom 10 %', apply: () => (mpv.set('panscan', 0), mpv.set('video-zoom', 0.1375)) },
  { id: '16:9', label: '16:9', apply: () => (mpv.set('video-aspect-override', '16:9'), mpv.set('panscan', 0), mpv.set('video-zoom', 0)) },
  { id: '4:3', label: '4:3', apply: () => (mpv.set('video-aspect-override', '4:3'), mpv.set('panscan', 0), mpv.set('video-zoom', 0)) },
  { id: '2.39:1', label: '2.39:1', apply: () => (mpv.set('video-aspect-override', '2.39:1'), mpv.set('panscan', 0), mpv.set('video-zoom', 0)) },
];

let currentAspect = 'fit';

export function VideoMenu() {
  const hwdec = useSettings((s) => s.settings.playback.hwdec);
  const setSettings = useSettings((s) => s.set);
  const current = usePlayer((s) => s.hwdec);
  return (
    <div className="menu" role="menu" onPointerDown={stop}>
      <h3 className="menu__heading">Picture</h3>
      {ASPECTS.map((a) => (
        <button
          key={a.id}
          className={`menu__item${currentAspect === a.id ? ' is-selected' : ''}`}
          role="menuitemradio"
          aria-checked={currentAspect === a.id}
          onClick={(e) => {
            currentAspect = a.id;
            a.apply();
            (e.currentTarget.parentElement as HTMLElement).querySelectorAll('.menu__item').forEach((el) => el.classList.remove('is-selected'));
            e.currentTarget.classList.add('is-selected');
          }}
        >
          <span className="menu__check">{currentAspect === a.id && <Check size={15} />}</span>
          <span className="menu__label">{a.label}</span>
        </button>
      ))}
      <div className="menu__divider" />
      <div className="menu__row">
        <div className="menu__row-text">
          <span className="menu__label">Hardware decoding</span>
          <span className="menu__hint">{current && current !== 'no' ? `In use: ${current}` : 'Off: the processor decodes'}</span>
        </div>
        <div className="segmented segmented--sm">
          <button className={`segmented__item ${hwdec !== 'no' ? 'is-on' : ''}`} onClick={() => setSettings('playback', { hwdec: 'auto-safe' })}>
            On
          </button>
          <button className={`segmented__item ${hwdec === 'no' ? 'is-on' : ''}`} onClick={() => setSettings('playback', { hwdec: 'no' })}>
            Off
          </button>
        </div>
      </div>
    </div>
  );
}

export function resetAspect() {
  currentAspect = 'fit';
}
