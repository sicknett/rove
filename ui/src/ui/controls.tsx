import { forwardRef, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Eye, EyeOff, X } from 'lucide-react';
import { WindowButtons } from '../components/TitleBar';

// ---------- Buttons ----------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  icon?: React.ReactNode;
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, busy, children, className = '', disabled, ...rest },
  ref,
) {
  return (
    <button ref={ref} className={`btn btn--${variant} btn--${size} ${busy ? 'is-busy' : ''} ${className}`} disabled={disabled || busy} {...rest}>
      {busy ? <span className="btn__spinner" aria-hidden /> : icon}
      {children && <span className="btn__label">{children}</span>}
    </button>
  );
});

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: 'sm' | 'md' | 'lg';
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ label, size = 'md', active, className = '', children, ...rest }, ref) {
  return (
    <button ref={ref} aria-label={label} title={label} className={`ibtn ibtn--${size} ${active ? 'is-active' : ''} ${className}`} {...rest}>
      {children}
    </button>
  );
});

// ---------- Switch ----------

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`switch ${checked ? 'is-on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="switch__thumb" />
    </button>
  );
}

// ---------- Segmented ----------

export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} role="radio" aria-checked={o.value === value} className={`segmented__item ${o.value === value ? 'is-on' : ''}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------- Text field ----------

interface FieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label?: string;
  hint?: React.ReactNode;
  error?: string | null;
  secret?: boolean;
  onChange: (v: string) => void;
  trailing?: React.ReactNode;
}

export const TextField = forwardRef<HTMLInputElement, FieldProps>(function TextField({ label, hint, error, secret, onChange, trailing, className = '', ...rest }, ref) {
  const id = useId();
  const [reveal, setReveal] = useState(false);
  return (
    <div className={`field ${error ? 'has-error' : ''} ${className}`}>
      {label && (
        <label className="field__label" htmlFor={id}>
          {label}
        </label>
      )}
      <div className="field__box">
        <input
          ref={ref}
          id={id}
          className="field__input"
          type={secret && !reveal ? 'password' : 'text'}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!!error}
          {...rest}
          onChange={(e) => onChange(e.target.value)}
        />
        {secret && (
          <button type="button" className="field__reveal" aria-label={reveal ? 'Hide' : 'Show'} onClick={() => setReveal((v) => !v)}>
            {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        )}
        {trailing}
      </div>
      {error ? <p className="field__error">{error}</p> : hint ? <p className="field__hint">{hint}</p> : null}
    </div>
  );
});

// ---------- Slider ----------

export function Slider({ value, min, max, step = 1, onChange, label, format }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label: string; format?: (v: number) => string }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="slider">
      <input
        type="range"
        className="slider__input"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        style={{ ['--fill' as string]: `${pct}%` }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {format && <span className="slider__value">{format(value)}</span>}
    </div>
  );
}

// ---------- Popover positioning ----------

function usePopoverPosition(anchor: React.RefObject<HTMLElement | null>, open: boolean, align: 'start' | 'end' = 'start', popover?: React.RefObject<HTMLElement | null>) {
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number; above: boolean; minWidth: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const place = () => {
      const r = anchor.current!.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const useAbove = below < 240 && above > below;
      setPos({
        top: useAbove ? r.top - 6 : r.bottom + 6,
        left: align === 'end' ? r.right : r.left,
        maxHeight: Math.max(160, (useAbove ? above : below) - 6),
        above: useAbove,
        minWidth: r.width,
      });
    };
    // Scrolling the list itself moves nothing it is anchored to.
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Node && popover?.current?.contains(e.target))) place();
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, anchor, align, popover]);
  return pos;
}

/**
 * Moves the keyboard into a popover once, when it appears. Not on every reposition: focusing
 * scrolls the item into view, which would pull a long list back while it is being scrolled.
 */
function useFocusOnOpen(open: boolean, shown: boolean, popover: React.RefObject<HTMLElement | null>, selectors: string[]) {
  const done = useRef(false);
  useEffect(() => {
    if (!open) {
      done.current = false;
      return;
    }
    if (done.current || !shown || !popover.current) return;
    done.current = true;
    for (const selector of selectors) {
      const el = popover.current.querySelector<HTMLElement>(selector);
      if (el) return el.focus();
    }
  }, [open, shown, popover, selectors]);
}

function useDismiss(open: boolean, close: () => void, refs: React.RefObject<HTMLElement | null>[]) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (refs.some((r) => r.current?.contains(e.target as Node))) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, close, refs]);
}

// ---------- Select ----------

/** What takes the keyboard when a list opens: the chosen option, else the first. */
const SELECT_FOCUS = ['[aria-selected="true"]', '[role="option"]'];
const MENU_FOCUS = ['[role="menuitem"]:not(:disabled)'];

export function Select<T extends string | number>({ value, options, onChange, label, className = '' }: { value: T; options: { value: T; label: string; detail?: string }[]; onChange: (v: T) => void; label: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const pos = usePopoverPosition(anchor, open, 'start', pop);
  useDismiss(open, () => setOpen(false), [anchor, pop]);
  const current = options.find((o) => o.value === value);
  useFocusOnOpen(open, !!pos, pop, SELECT_FOCUS);

  const onListKey = (e: React.KeyboardEvent) => {
    const items = [...(pop.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[Math.min(items.length - 1, i + 1)]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[Math.max(0, i - 1)]?.focus();
    }
  };

  return (
    <>
      <button ref={anchor} type="button" className={`select ${className}`} aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={() => setOpen((v) => !v)}>
        <span className="select__value">{current?.label ?? '—'}</span>
        <ChevronDown size={16} className="select__chevron" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={pop}
            className={`popover popover--list ${pos.above ? 'is-above' : ''}`}
            role="listbox"
            aria-label={label}
            onKeyDown={onListKey}
            style={{ top: pos.above ? undefined : pos.top, bottom: pos.above ? window.innerHeight - pos.top : undefined, left: pos.left, minWidth: Math.max(pos.minWidth, 200), maxHeight: pos.maxHeight }}
          >
            {options.map((o) => (
              <button
                key={String(o.value)}
                role="option"
                aria-selected={o.value === value}
                className={`popover__item ${o.value === value ? 'is-selected' : ''}`}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                  anchor.current?.focus();
                }}
              >
                <span className="popover__check">{o.value === value && <Check size={15} />}</span>
                <span className="popover__text">
                  <span>{o.label}</span>
                  {o.detail && <span className="popover__detail">{o.detail}</span>}
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

// ---------- Menu ----------

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export function Menu({ trigger, items, align = 'end' }: { trigger: (props: { ref: React.RefObject<HTMLButtonElement | null>; onClick: () => void; 'aria-expanded': boolean }) => React.ReactNode; items: (MenuItem | 'divider')[]; align?: 'start' | 'end' }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const pos = usePopoverPosition(anchor, open, align, pop);
  useDismiss(open, () => setOpen(false), [anchor, pop]);
  useFocusOnOpen(open, !!pos, pop, MENU_FOCUS);
  return (
    <>
      {trigger({ ref: anchor, onClick: () => setOpen((v) => !v), 'aria-expanded': open })}
      {open &&
        pos &&
        createPortal(
          <div
            ref={pop}
            className={`popover popover--menu ${pos.above ? 'is-above' : ''} ${align === 'end' ? 'is-end' : ''}`}
            role="menu"
            onKeyDown={(e) => {
              const items = [...(pop.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
              const i = items.indexOf(document.activeElement as HTMLElement);
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                items[(i + 1) % items.length]?.focus();
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                items[(i - 1 + items.length) % items.length]?.focus();
              }
            }}
            style={{
              top: pos.above ? undefined : pos.top,
              bottom: pos.above ? window.innerHeight - pos.top : undefined,
              left: align === 'end' ? undefined : pos.left,
              right: align === 'end' ? window.innerWidth - pos.left : undefined,
              maxHeight: pos.maxHeight,
            }}
          >
            {items.map((it, i) =>
              it === 'divider' ? (
                <div key={i} className="popover__divider" />
              ) : (
                <button
                  key={i}
                  role="menuitem"
                  disabled={it.disabled}
                  className={`popover__item ${it.danger ? 'is-danger' : ''}`}
                  onClick={() => {
                    setOpen(false);
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
        )}
    </>
  );
}

// ---------- Dialog and sheet ----------

function useFocusTrap(ref: React.RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active || !ref.current) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () => [...node.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute('disabled'));
    (node.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0] ?? node).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    node.addEventListener('keydown', onKey);
    return () => {
      node.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [ref, active]);
}

/**
 * Escape closes a dialog or sheet, unless something on top of it takes the key first: an open
 * dropdown or menu (that closes instead, and the dialog keeps its unsaved edits), or a dialog
 * opened over this one.
 */
function useEscape(ref: React.RefObject<HTMLElement | null>, active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.popover')) return;
      const overlays = document.querySelectorAll('.overlay');
      if (overlays[overlays.length - 1] !== ref.current?.parentElement) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ref, active, onClose]);
}

export function Dialog({ open, onClose, title, children, footer, width = 520, dismissable = true }: { open: boolean; onClose: () => void; title?: string; children: React.ReactNode; footer?: React.ReactNode; width?: number; dismissable?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, open);
  useEscape(ref, open && dismissable, onClose);
  if (!open) return null;
  return createPortal(
    <div className="overlay" onPointerDown={(e) => dismissable && e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-label={title} style={{ width: `min(${width}px, calc(100vw - 48px))` }} tabIndex={-1}>
        {title && (
          <header className="dialog__head">
            <h2 className="dialog__title">{title}</h2>
            {dismissable && (
              <IconButton label="Close" size="sm" onClick={onClose}>
                <X size={18} />
              </IconButton>
            )}
          </header>
        )}
        <div className="dialog__body">{children}</div>
        {footer && <footer className="dialog__foot">{footer}</footer>}
      </div>
      <WindowButtons />
    </div>,
    document.body,
  );
}

export function Sheet({ open, onClose, title, subtitle, children, width = 560 }: { open: boolean; onClose: () => void; title: string; subtitle?: React.ReactNode; children: React.ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, open);
  useEscape(ref, open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="overlay overlay--sheet" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={ref} className="sheet" role="dialog" aria-modal="true" aria-label={title} style={{ width: `min(${width}px, 92vw)` }} tabIndex={-1}>
        <header className="sheet__head">
          <div className="sheet__titles">
            <h2 className="sheet__title">{title}</h2>
            {subtitle && <div className="sheet__subtitle">{subtitle}</div>}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <X size={20} />
          </IconButton>
        </header>
        <div className="sheet__body">{children}</div>
      </aside>
      <WindowButtons />
    </div>,
    document.body,
  );
}

// ---------- Small pieces ----------

export function Spinner({ size = 28 }: { size?: number }) {
  return <span className="spinner-sm" style={{ width: size, height: size }} role="status" aria-label="Loading" />;
}

export function Skeleton({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  return <span className={`skeleton ${className}`} style={style} aria-hidden />;
}

export function Empty({ icon, title, children, action }: { icon?: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty__icon">{icon}</div>}
      <h3 className="empty__title">{title}</h3>
      {children && <p className="empty__text">{children}</p>}
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}

export function ProgressLine({ value }: { value: number }) {
  return (
    <span className="progressline" aria-hidden>
      <span className="progressline__fill" style={{ transform: `scaleX(${Math.max(0, Math.min(1, value))})` }} />
    </span>
  );
}
