import { useEffect, useRef, useState } from 'react';
import { useScreen } from '../../nav/router';
import { useAmbientPage } from './ambient';

/**
 * The banner's colour behind all of Home. Two flat sheets pinned to the window: a new colour is
 * put on the hidden one, which then fades in over the other. Only opacity ever changes, so the
 * browser never repaints the page for it and there is nothing (no gradient, no partial redraw)
 * that could show an edge.
 */
export function AmbientLayer({ color }: { color: string | undefined }) {
  const [sheets, setSheets] = useState<{ a?: string; b?: string; front: 'a' | 'b' }>({ front: 'a' });
  const last = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (color === last.current) return;
    last.current = color;
    setSheets((s) => (s.front === 'a' ? { ...s, b: color, front: 'b' } : { ...s, a: color, front: 'a' }));
  }, [color]);
  // The navigation bar shades itself to match while Home is the screen in front.
  const { active } = useScreen();
  useEffect(() => {
    useAmbientPage.setState({ color: active ? color : undefined });
    return () => useAmbientPage.setState({ color: undefined });
  }, [active, color]);
  return (
    <div className="home__ambient" aria-hidden>
      <div className={`home__tint ${sheets.front === 'a' && sheets.a ? 'is-on' : ''}`} style={{ backgroundColor: sheets.a }} />
      <div className={`home__tint ${sheets.front === 'b' && sheets.b ? 'is-on' : ''}`} style={{ backgroundColor: sheets.b }} />
    </div>
  );
}
