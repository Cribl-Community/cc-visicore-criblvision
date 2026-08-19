import type { ReactNode } from 'react';
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
}: {
  label: string;
  value: string;
  unit?: string;
  foot?: ReactNode;
  delta?: { text: string; dir: 'up' | 'down' | 'flat' };
  accent?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="stat">
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
