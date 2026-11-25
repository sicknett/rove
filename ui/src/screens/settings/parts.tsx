// Building blocks for settings pages: groups of rows, each with a label, a hint and a control;
// the "Advanced" disclosure; colour swatches; and the links between pages.

import { createContext, useContext, useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { DEFAULT_SETTINGS, useSettings } from '../../state/settings';
import { entryOf, sectionPaths, type SectionId } from './catalog';
import { changedPaths } from './reset';

/** A control a search result, a link or a moved section asked for. Each ask is a new object. */
export interface FocusTarget {
  id: string;
}

interface SettingsNav {
  target: FocusTarget | null;
  /** Opens the page a control is on and brings the control into view. */
  go: (id: string) => void;
}

/** Outside Settings (the collection editor uses these rows too) there is nothing to jump to. */
export const SettingsNavContext = createContext<SettingsNav>({ target: null, go: () => undefined });
export const useSettingsNav = () => useContext(SettingsNavContext);

export function Group({ id, title, children, note, tone }: { id?: string; title?: string; children: React.ReactNode; note?: React.ReactNode; tone?: 'danger' }) {
  return (
    <section className={`s-group ${tone ? `s-group--${tone}` : ''}`} data-setting={id}>
      {title && <h3 className="s-group__title">{title}</h3>}
      <div className="s-group__rows">{children}</div>
      {note && <p className="s-group__note">{note}</p>}
    </section>
  );
}

interface RowProps {
  /** Its entry in the catalog: gives the label and the hint, and makes the row findable. */
  id?: string;
  /** Needed without an `id`; with one, it replaces the catalog's label. */
  label?: string;
  /** Replaces the catalog's hint, for one that describes the current choice. */
  hint?: React.ReactNode;
  children?: React.ReactNode;
  stacked?: boolean;
  /**
   * Why the control cannot be used right now ("The banner is off."). The control is disabled
   * and the reason is shown where the hint was, so nothing is greyed out without saying why.
   */
  disabled?: React.ReactNode;
}

export function SettingRow({ id, label, hint, children, stacked, disabled }: RowProps) {
  const known = id ? entryOf(id) : undefined;
  const text = label ?? known?.label ?? '';
  const help = disabled || (hint ?? known?.hint);
  return (
    <div className={`s-row ${stacked ? 's-row--stacked' : ''} ${disabled ? 'is-disabled' : ''}`} data-setting={id}>
      <div className="s-row__text">
        <span className="s-row__label">{text}</span>
        {help && <span className={`s-row__hint ${disabled ? 's-row__hint--reason' : ''}`}>{help}</span>}
      </div>
      {children && (
        // A disabled fieldset disables every control inside it, whatever kind it is.
        <fieldset className="s-row__control" disabled={!!disabled} aria-label={text}>
          {children}
        </fieldset>
      )}
    </div>
  );
}

/** Which sections have "Advanced" open. Kept while the app runs, so coming back finds it as it was left. */
const advancedOpen = new Map<SectionId, boolean>();

/**
 * The rare and expert settings of a section, folded away under the everyday ones. The line says
 * what is inside and how many of them are not at their default, so nothing changed hides unseen.
 */
export function Advanced({ section, contains, children }: { section: SectionId; contains: string; children: React.ReactNode }) {
  const panel = useId();
  const { target } = useSettingsNav();
  const [open, setOpen] = useState(() => advancedOpen.get(section) ?? false);
  const [seen, setSeen] = useState<FocusTarget | null>(null);
  const changed = useSettings((s) => changedPaths(s.settings, DEFAULT_SETTINGS, sectionPaths(section, 'advanced')).length);
  // Asked for a control in here: open before the page looks for it.
  if (target && target !== seen) {
    setSeen(target);
    const wanted = entryOf(target.id);
    if (wanted?.advanced && wanted.section === section && !open) {
      advancedOpen.set(section, true);
      setOpen(true);
    }
  }
  const toggle = () => {
    advancedOpen.set(section, !open);
    setOpen(!open);
  };
  return (
    <section className={`s-adv ${open ? 'is-open' : ''}`}>
      <button type="button" className="s-adv__toggle" aria-expanded={open} aria-controls={panel} onClick={toggle}>
        <ChevronDown size={16} className="s-adv__chevron" />
        <span className="s-adv__text">
          <span className="s-adv__label">Advanced</span>
          <span className="s-adv__contains">{contains}</span>
        </span>
        {changed > 0 && <span className="s-adv__changed">{changed} changed</span>}
      </button>
      <div id={panel} className="s-adv__panel" hidden={!open}>
        {open && children}
      </div>
    </section>
  );
}

export interface SwatchOption<T extends string> {
  value: T;
  color: string;
  label: string;
}

/** A choice of colours: one is always chosen, and each says its name. */
export function Swatches<T extends string>({ label, value, options, onChange, large }: { label: string; value: T; options: SwatchOption<T>[]; onChange: (v: T) => void; large?: boolean }) {
  return (
    <div className="swatches" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          aria-label={o.label}
          title={o.label}
          className={`swatch ${large ? 'swatch--lg' : ''} ${o.value === value ? 'is-on' : ''}`}
          style={{ background: o.color }}
          onClick={() => onChange(o.value)}
        />
      ))}
    </div>
  );
}

/** Makes a button that is not a row of its own (one of several in an action row) findable by search. */
export function Anchor({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <span className="s-anchor" data-setting={id}>
      {children}
    </span>
  );
}

/** A sentence under a page that points at a related setting on another one. */
export function SeeAlso({ children }: { children: React.ReactNode }) {
  return <p className="s-seealso">{children}</p>;
}

/** A link inside a sentence that jumps to another setting. */
export function SettingLink({ to, children }: { to: string; children: React.ReactNode }) {
  const { go } = useSettingsNav();
  return (
    <button type="button" className="s-link" onClick={() => go(to)}>
      {children}
    </button>
  );
}
