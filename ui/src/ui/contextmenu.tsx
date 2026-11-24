// Right-click menus at the pointer, shared by every card.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import type { MenuItem } from './controls';

interface CtxState {
  open: { x: number; y: number; items: (MenuItem | 'divider')[] } | null;
  show: (x: number, y: number, items: (MenuItem | 'divider')[]) => void;
  close: () => void;
}

export const useContextMenu = create<CtxState>((set) => ({
  open: null,
  show: (x, y, items) => set({ open: { x, y, items } }),
  close: () => set({ open: null }),
}));

export function openContextMenu(e: React.MouseEvent, items: (MenuItem | 'divider')[]) {
  e.preventDefault();
  e.stopPropagation();
  useContextMenu.getState().show(e.clientX, e.clientY, items);
}

export function ContextMenuHost() {
  const open = useContextMenu((s) => s.open);
  const close = useContextMenu((s) => s.close);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !ref.current) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    setPos({ left: Math.min(open.x, window.innerWidth - r.width - 8), top: Math.min(open.y, window.innerHeight - r.height - 8) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
    window.addEventListener('wheel', close, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('wheel', close);
    };
  }, [open, close]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      className="popover popover--menu popover--context"
      role="menu"
      style={{ left: pos?.left ?? open.x, top: pos?.top ?? open.y, visibility: pos ? 'visible' : 'hidden' }}
      onKeyDown={(e) => {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLElement);
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          items[(i + 1) % items.length]?.focus();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          items[(i - 1 + items.length) % items.length]?.focus();
        }
      }}
    >
      {open.items.map((it, i) =>
        it === 'divider' ? (
          <div key={i} className="popover__divider" />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            className={`popover__item ${it.danger ? 'is-danger' : ''}`}
            onClick={() => {
              close();
              it.onSelect();
            }}
          >
            <span className="popover__icon">{it.icon}</span>
            <span className="popover__text">{it.label}</span>
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
