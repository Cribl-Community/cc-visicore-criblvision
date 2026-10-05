import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Health } from '../api/types';
import { normHealth } from '../lib/metrics';

// ---- Card ---------------------------------------------------------------
export function Card({
  title,
  note,
  right,
  children,
  className = '',
}: {
  title?: string;
  note?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`card ${className}`}>
      {(title || right) && (
        <div className="card-head">
          <span className="card-title">{title}</span>
          {right ?? (note && <span className="card-note">{note}</span>)}
        </div>
      )}
      {children}
    </div>
  );
}

// ---- Stat tile ----------------------------------------------------------
export function StatTile({
  label,
  value,
  unit,
  foot,
  delta,
  accent,
  icon,
  onClick,
  active,
}: {
  label: string;
  value: string;
  unit?: string;
  foot?: ReactNode;
  delta?: { text: string; dir: 'up' | 'down' | 'flat' };
  accent?: string;
  icon?: ReactNode;
  /** Makes the tile a toggle, e.g. to filter the page down to what it counts. */
  onClick?: () => void;
  active?: boolean;
}) {
  const toggle = onClick && {
    role: 'button',
    tabIndex: 0,
    'aria-pressed': !!active,
    onClick,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick();
      }
    },
  };
  return (
    <div className={`stat${onClick ? ' stat-clickable' : ''}${active ? ' active' : ''}`} {...toggle}>
      <div className="stat-row">
        {accent && <span className="stat-accent" style={{ background: accent }} />}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="stat-label">
            {icon}
            {label}
          </div>
          <div className="stat-value">
            {value}
            {unit && <span className="unit">{unit}</span>}
          </div>
          {(foot || delta) && (
            <div className="stat-foot">
              {delta && (
                <span className={`delta-${delta.dir}`}>
                  {delta.dir === 'up' ? '▲' : delta.dir === 'down' ? '▼' : '＝'} {delta.text}
                </span>
              )}
              {foot}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Health badge -------------------------------------------------------
const HEALTH_LABEL: Record<Health, string> = {
  Green: 'Healthy',
  Yellow: 'Warning',
  Red: 'Unhealthy',
  Unknown: 'Unknown',
};
const HEALTH_CLASS: Record<Health, string> = {
  Green: 'badge-green',
  Yellow: 'badge-yellow',
  Red: 'badge-red',
  Unknown: 'badge-gray',
};

export function HealthBadge({ health, label }: { health: string | undefined; label?: string }) {
  const h = normHealth(health);
  return (
    <span className={`badge ${HEALTH_CLASS[h]}`}>
      <span className="dot" />
      {label ?? HEALTH_LABEL[h]}
    </span>
  );
}

// ---- Meter --------------------------------------------------------------
export function Meter({ pct, color }: { pct: number; color?: string }) {
  const p = Math.max(0, Math.min(100, pct));
  const c = color ?? (p > 90 ? 'var(--critical)' : p > 75 ? 'var(--warning)' : 'var(--good)');
  return (
    <div className="meter">
      <div className="meter-fill" style={{ width: `${p}%`, background: c }} />
    </div>
  );
}

// ---- Bar list -----------------------------------------------------------
export function BarList({
  items,
  color = 'var(--series-in)',
  colorFor,
  formatValue,
}: {
  items: { id: string; value: number }[];
  color?: string;
  /** Per-item color override (e.g. severity-coded rows) — falls back to `color`. */
  colorFor?: (id: string) => string;
  formatValue: (n: number) => string;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (items.length === 0) return <div className="center-state">No data</div>;
  return (
    <div className="barlist">
      {items.map((it) => (
        <div className="barlist-row" key={it.id}>
          <span className="barlist-label" title={it.id}>
            {it.id}
          </span>
          <span className="barlist-val">{formatValue(it.value)}</span>
          <div className="barlist-track">
            <div
              className="barlist-fill"
              style={{ width: `${(it.value / max) * 100}%`, background: colorFor ? colorFor(it.id) : color }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- Chip multiselect -----------------------------------------------------
/**
 * Toggleable chip list for filtering a split-by dimension to specific ids.
 * `null` selection means "all"; clicking the active chip set back down to
 * empty snaps back to "all" rather than leaving a not-possible empty filter.
 */
export function ChipSelect({
  options,
  selected,
  onChange,
  swatch,
}: {
  options: string[];
  selected: Set<string> | null;
  onChange: (next: Set<string> | null) => void;
  /** Optional per-id color dot (e.g. to preview the chart's series color). */
  swatch?: (id: string) => string | undefined;
}) {
  function toggle(id: string) {
    if (selected == null) {
      onChange(new Set([id]));
      return;
    }
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next.size === 0 ? null : next);
  }

  if (options.length === 0) return <span className="muted" style={{ fontSize: 12.5 }}>No data yet</span>;

  return (
    <div className="chip-select">
      <button className={`chip ${selected == null ? 'active' : ''}`} onClick={() => onChange(null)}>
        All
      </button>
      {options.map((id) => (
        <button
          key={id}
          className={`chip ${selected?.has(id) ? 'active' : ''}`}
          onClick={() => toggle(id)}
          title={id}
        >
          {swatch && <span className="chip-swatch" style={{ background: swatch(id) }} />}
          {id}
        </button>
      ))}
    </div>
  );
}

// ---- Dropdown multiselect -------------------------------------------------
/**
 * Searchable dropdown for filtering to specific ids — the compact alternative
 * to ChipSelect when the option list is too long to lay out as chips. Same
 * contract: `null` selection means "all". Picked ids show as removable chips.
 */
export function MultiSelect({
  options,
  selected,
  onChange,
  noun,
}: {
  options: string[];
  selected: Set<string> | null;
  onChange: (next: Set<string> | null) => void;
  /** Plural name of what is being picked, e.g. "destinations". */
  noun: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function toggle(id: string) {
    const next = new Set(selected ?? []);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next.size === 0 ? null : next);
  }

  if (options.length === 0) return <span className="muted" style={{ fontSize: 12.5 }}>No data yet</span>;

  const needle = q.trim().toLowerCase();
  const shown = needle ? options.filter((id) => id.toLowerCase().includes(needle)) : options;
  const picked = options.filter((id) => selected?.has(id));

  return (
    <div className="multi" ref={root}>
      <button
        type="button"
        className="select multi-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {selected == null ? `All ${noun} (${options.length})` : `${picked.length} of ${options.length} ${noun}`}
        <span className="multi-caret">▾</span>
      </button>
      {picked.length > 0 && (
        <div className="chip-select">
          {picked.map((id) => (
            <button key={id} className="chip active" onClick={() => toggle(id)} title={`Remove ${id}`}>
              {id} ✕
            </button>
          ))}
          <button className="chip" onClick={() => onChange(null)}>
            Clear
          </button>
        </div>
      )}
      {open && (
        <div className="multi-menu">
          <input
            className="select"
            autoFocus
            placeholder={`Search ${noun}…`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="multi-list" role="listbox" aria-multiselectable="true">
            {shown.map((id) => (
              <label key={id} className="multi-option" title={id}>
                <input type="checkbox" checked={!!selected?.has(id)} onChange={() => toggle(id)} />
                <span>{id}</span>
              </label>
            ))}
            {shown.length === 0 && (
              <div className="muted" style={{ fontSize: 12.5, padding: 6 }}>
                No {noun} match
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Searchable single select ---------------------------------------------
/**
 * A dropdown you can also type into: opens a list of options with a search box
 * on top, so a long list (routes, pipelines) can be narrowed by name. `null`
 * means "all".
 */
export function SearchSelect({
  options,
  value,
  onChange,
  noun,
}: {
  options: string[];
  value: string | null;
  onChange: (next: string | null) => void;
  /** Plural name of what is being picked, e.g. "routes". */
  noun: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function pick(next: string | null) {
    onChange(next);
    setOpen(false);
    setQ('');
  }

  const needle = q.trim().toLowerCase();
  const shown = needle ? options.filter((id) => id.toLowerCase().includes(needle)) : options;

  return (
    <div className="multi" ref={root}>
      <button
        type="button"
        className="select multi-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="multi-value">{value ?? `All ${noun} (${options.length})`}</span>
        <span className="multi-caret">▾</span>
      </button>
      {open && (
        <div className="multi-menu">
          <input
            className="select"
            autoFocus
            placeholder={`Type to find ${noun}…`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
              // Enter takes the top match, so typing a name and pressing Enter is enough.
              if (e.key === 'Enter' && shown.length > 0) pick(shown[0]);
            }}
          />
          <div className="multi-list" role="listbox">
            {!needle && (
              <button type="button" className={`multi-option${value == null ? ' active' : ''}`} onClick={() => pick(null)}>
                All {noun}
              </button>
            )}
            {shown.map((id) => (
              <button
                type="button"
                key={id}
                className={`multi-option${id === value ? ' active' : ''}`}
                title={id}
                onClick={() => pick(id)}
              >
                <span>{id}</span>
              </button>
            ))}
            {shown.length === 0 && (
              <div className="muted" style={{ fontSize: 12.5, padding: 6 }}>
                No {noun} match
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- States -------------------------------------------------------------
export function Loading({ height = 200 }: { height?: number }) {
  return (
    <div className="center-state" style={{ height }}>
      <span className="spinner" />
      Loading…
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return <div className="error-banner">⚠ {message}</div>;
}

// ---- Key/value list -----------------------------------------------------
export function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}
