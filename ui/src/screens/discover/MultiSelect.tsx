// A dropdown that takes several choices at once (genres, watch providers). It looks and behaves
// like `Select` in ui/controls.tsx and uses the same popover styles; that one closes on a choice
// and holds a single value, and its positioning and dismissal are not exported, so the little of
// both that is needed is here.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { useScreen } from '../../nav/router';
import { Img } from '../../ui/Img';

export interface MultiOption {
  value: number;
  label: string;
  /** A small picture before the label (a provider's logo). */
  image?: string;
}

interface Props {
  /** What is being chosen, for screen readers and the list's name. */
  label: string;
  /** What the button says: the name of the filter, or what is chosen. */
  text: string;
  options: MultiOption[];
  values: number[];
  onChange: (values: number[]) => void;
  /** Above the options (the country, for where to watch). */
  header?: React.ReactNode;
  /** In place of the options while there are none: loading, failed, nothing offered. */
  note?: React.ReactNode;
  /** Called the first time the list opens, for options that are fetched only when wanted. */
  onOpen?: () => void;
}

export function MultiSelect({ label, text, options, values, onChange, header, note, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const chosen = new Set(values);
  // The list is drawn over the whole window. When its screen is left by a key (Back) it would
  // stay there, over another page: it closes with its screen.
  const { active } = useScreen();
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const place = () => {
      const r = anchor.current!.getBoundingClientRect();
      setPos({ top: r.bottom + 6, left: Math.min(r.left, window.innerWidth - 300), maxHeight: Math.max(200, window.innerHeight - r.bottom - 24) });
    };
    // Scrolling the list itself moves nothing it is anchored to.
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Node && pop.current?.contains(e.target))) place();
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      // A dropdown opened from inside this one (the country) is its own popover: a click in it is not a click away.
      if (anchor.current?.contains(t) || t.closest?.('.popover')) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // With a dropdown open on top of this one, Escape is that one's.
      if (e.key !== 'Escape' || document.querySelectorAll('.popover').length > 1) return;
      e.stopPropagation();
      setOpen(false);
      anchor.current?.focus();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  // The keyboard moves into the list once, when it appears.
  const placed = !!pos;
  useEffect(() => {
    if (open && placed) (pop.current?.querySelector<HTMLElement>('[role="option"]') ?? pop.current)?.focus();
  }, [open, placed]);

  const toggle = (v: number) => onChange(chosen.has(v) ? values.filter((x) => x !== v) : [...values, v]);

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(pop.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    items[e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)]?.focus();
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`select select--compact ${values.length ? 'is-set' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen((v) => !v);
        }}
      >
        <span className="select__value">{text}</span>
        {values.length > 0 && <span className="select__count">{values.length}</span>}
        <ChevronDown size={16} className="select__chevron" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div ref={pop} className="popover popover--list popover--multi" tabIndex={-1} style={{ top: pos.top, left: pos.left, maxHeight: pos.maxHeight }}>
            {header && <div className="popover__head">{header}</div>}
            <div role="listbox" aria-multiselectable aria-label={label} onKeyDown={onListKey}>
              {options.map((o) => (
                <button key={o.value} role="option" aria-selected={chosen.has(o.value)} className={`popover__item ${chosen.has(o.value) ? 'is-selected' : ''}`} onClick={() => toggle(o.value)}>
                  <span className="popover__check">{chosen.has(o.value) && <Check size={15} />}</span>
                  {o.image && <Img src={o.image} alt="" className="popover__logo" />}
                  <span className="popover__text">{o.label}</span>
                </button>
              ))}
            </div>
            {!options.length && note && <p className="popover__note">{note}</p>}
            {values.length > 0 && (
              <>
                <div className="popover__divider" />
                <button className="popover__item" onClick={() => onChange([])}>
                  <span className="popover__check" />
                  <span className="popover__text">Clear</span>
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
