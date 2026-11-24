import { useEffect, useRef, useState } from 'react';
import { mpv } from '../bridge';
import { formatTime } from '../format';
import { getPlayerState, usePlayer } from './store';
import type { Segment } from './skips';

/** Position between mpv's ~30 Hz updates, so the bar glides instead of stepping. */
function livePosition() {
  const s = getPlayerState();
  if (s.pause || s.pausedForCache || s.seeking || s.loading || !s.timeStamp) return s.timePos;
  const elapsed = (performance.now() - s.timeStamp) / 1000;
  return Math.min(s.timePos + Math.min(elapsed, 0.25) * s.speed, s.duration || Infinity);
}

export function Scrubber({ segments = [] }: { segments?: Segment[] }) {
  const duration = usePlayer((s) => s.duration);
  const cacheTime = usePlayer((s) => s.cacheTime);
  const chapters = usePlayer((s) => s.chapters);
  const trackRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const elapsedRef = useRef<HTMLSpanElement>(null);
  const remainingRef = useRef<HTMLSpanElement>(null);
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null);
  const dragging = useRef<number | null>(null);

  // Draw the position every frame without re-rendering React.
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      const { duration: d } = getPlayerState();
      const pos = dragging.current ?? livePosition();
      const ratio = d > 0 ? Math.max(0, Math.min(1, pos / d)) : 0;
      if (fillRef.current) fillRef.current.style.transform = `scaleX(${ratio})`;
      if (knobRef.current) knobRef.current.style.left = `${ratio * 100}%`;
      if (elapsedRef.current) elapsedRef.current.textContent = formatTime(pos);
      if (remainingRef.current) remainingRef.current.textContent = d > 0 ? `-${formatTime(d - pos)}` : '';
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  const timeAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || duration <= 0) return { x: 0, time: 0 };
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    return { x, time: (x / rect.width) * duration };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (duration <= 0 || e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = timeAt(e.clientX).time;
    trackRef.current?.classList.add('is-dragging');
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const at = timeAt(e.clientX);
    setHover(at);
    if (dragging.current !== null) dragging.current = at.time;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (dragging.current === null) return;
    const target = timeAt(e.clientX).time;
    dragging.current = null;
    trackRef.current?.classList.remove('is-dragging');
    mpv.command('seek', target.toFixed(3), 'absolute');
  };

  const buffered = duration > 0 ? Math.min(1, cacheTime / duration) : 0;

  return (
    <div className="scrubber">
      <span className="scrubber__time" ref={elapsedRef}>0:00</span>
      <div
        className="scrubber__hit"
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
        role="slider"
        aria-label="Position"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
      >
        <div className="scrubber__track">
          <div className="scrubber__buffered" style={{ transform: `scaleX(${buffered})` }} />
          <div className="scrubber__fill" ref={fillRef} />
          {duration > 0 &&
            segments.map((sg, i) => (
              <div
                key={`s${i}`}
                className={`scrubber__segment scrubber__segment--${sg.kind}`}
                title={sg.kind}
                style={{ left: `${(sg.start / duration) * 100}%`, width: `${(((sg.end ?? duration) - sg.start) / duration) * 100}%` }}
              />
            ))}
          {duration > 0 && chapters.filter((c) => c.time > 1 && c.time < duration - 1).map((c, i) => (
            <div key={i} className="scrubber__chapter" style={{ left: `${(c.time / duration) * 100}%` }} />
          ))}
        </div>
        <div className="scrubber__knob" ref={knobRef} />
        {hover && duration > 0 && (
          <div className="scrubber__tooltip" style={{ left: hover.x }}>
            {chapterAt(chapters, hover.time) && <span className="scrubber__tooltip-chapter">{chapterAt(chapters, hover.time)}</span>}
            {formatTime(hover.time)}
          </div>
        )}
      </div>
      <span className="scrubber__time scrubber__time--right" ref={remainingRef} />
    </div>
  );
}

function chapterAt(chapters: { title?: string; time: number }[], t: number): string | undefined {
  let title: string | undefined;
  for (const c of chapters) if (c.time <= t) title = c.title;
  return title && !/^chapter \d+$/i.test(title) ? title : undefined;
}
