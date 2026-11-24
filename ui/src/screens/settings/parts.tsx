// Building blocks for settings pages: groups of rows, each with a label, a hint and a control.

export function Group({ title, children, note }: { title?: string; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <section className="s-group">
      {title && <h3 className="s-group__title">{title}</h3>}
      <div className="s-group__rows">{children}</div>
      {note && <p className="s-group__note">{note}</p>}
    </section>
  );
}

export function SettingRow({ label, hint, children, stacked }: { label: string; hint?: React.ReactNode; children?: React.ReactNode; stacked?: boolean }) {
  return (
    <div className={`s-row ${stacked ? 's-row--stacked' : ''}`}>
      <div className="s-row__text">
        <span className="s-row__label">{label}</span>
        {hint && <span className="s-row__hint">{hint}</span>}
      </div>
      {children && <div className="s-row__control">{children}</div>}
    </div>
  );
}
