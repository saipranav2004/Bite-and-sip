// Building blocks for the staff console: page header, period picker, KPI cards,
// panels and loading skeletons. Layout rules follow common enterprise patterns
// (Polaris, Primer, Carbon): one primary action per page, numbers right-aligned
// with tabular figures, direction shown with an arrow and sign — never colour alone.
import { useId, useState, type ReactNode } from 'react'
import { addDays, cafeDate, formatDay, monthStart, percent } from '../lib/format'
import { readJson, writeJson } from '../lib/storage'

// ---- Page header ------------------------------------------------------------
export function PageHeader({
  title, subtitle, actions, children,
}: { title: string; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-5">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[22px] leading-tight font-extrabold tracking-tight sm:text-2xl">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </header>
  )
}

/** Standard page body width and padding for the console. */
export function PageBody({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <main className={`mx-auto w-full px-4 pt-5 pb-28 sm:px-6 md:pb-12 ${wide ? 'max-w-[1500px]' : 'max-w-[1200px]'}`}>{children}</main>
}

// ---- Period picker ----------------------------------------------------------
export type PeriodPreset = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'last_month' | 'custom'
export interface Period {
  preset: PeriodPreset
  from: string
  to: string
}

const PRESETS: { value: Exclude<PeriodPreset, 'custom'>; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
]

export function rangeFor(preset: Exclude<PeriodPreset, 'custom'>, today = cafeDate()): { from: string; to: string } {
  switch (preset) {
    case 'today':
      return { from: today, to: today }
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1) }
    case '7d':
      return { from: addDays(today, -6), to: today }
    case '30d':
      return { from: addDays(today, -29), to: today }
    case 'month':
      return { from: monthStart(today), to: today }
    case 'last_month': {
      const end = addDays(monthStart(today), -1)
      return { from: monthStart(end), to: end }
    }
  }
}

export function periodLabel(p: Period) {
  if (p.preset !== 'custom') return PRESETS.find((x) => x.value === p.preset)!.label
  return p.from === p.to ? formatDay(p.from) : `${formatDay(p.from)} – ${formatDay(p.to)}`
}

/** Remembers the chosen period per page for this browser session. */
export function usePeriod(key: string, initial: Exclude<PeriodPreset, 'custom'> = 'today') {
  const storageKey = `bitesip-period-${key}`
  const [period, setPeriodState] = useState<Period>(() => {
    const saved = readJson<Period | null>(storageKey, null, 'session')
    if (saved && saved.preset !== 'custom') return { preset: saved.preset, ...rangeFor(saved.preset) }
    if (saved?.preset === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(saved.from) && /^\d{4}-\d{2}-\d{2}$/.test(saved.to)) return saved
    return { preset: initial, ...rangeFor(initial) }
  })
  const setPeriod = (p: Period) => {
    setPeriodState(p)
    writeJson(storageKey, p, 'session')
  }
  return [period, setPeriod] as const
}

export function PeriodPicker({ value, onChange, maxDays = 92 }: { value: Period; onChange: (p: Period) => void; maxDays?: number }) {
  const fromId = useId()
  const toId = useId()
  const today = cafeDate()
  const [error, setError] = useState<string | null>(null)

  function setCustom(from: string, to: string) {
    if (!from || !to) return
    if (to < from) return setError('The end date is before the start date.')
    if (addDays(from, maxDays) < to) return setError(`Choose up to ${maxDays + 1} days.`)
    setError(null)
    onChange({ preset: 'custom', from, to })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0" role="group" aria-label="Period">
        <div className="inline-flex gap-1 rounded-lg border border-line bg-surface p-1">
          {[...PRESETS, { value: 'custom' as const, label: 'Custom' }].map((p) => (
            <button
              key={p.value}
              type="button"
              aria-pressed={value.preset === p.value}
              onClick={() => {
                if (p.value === 'custom') onChange({ ...value, preset: 'custom' })
                else onChange({ preset: p.value, ...rangeFor(p.value) })
              }}
              className={`min-h-9 shrink-0 rounded-md px-3 text-sm font-semibold whitespace-nowrap transition-colors ${
                value.preset === p.value ? 'bg-ink text-white' : 'text-ink-2 hover:bg-sunken'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {value.preset === 'custom' && (
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor={fromId} className="mb-1 block text-xs font-semibold text-muted">From</label>
            <input id={fromId} type="date" max={today} className="field-input min-h-10 !rounded-md !py-1.5" value={value.from} onChange={(e) => setCustom(e.target.value, value.to)} />
          </div>
          <div>
            <label htmlFor={toId} className="mb-1 block text-xs font-semibold text-muted">To</label>
            <input id={toId} type="date" max={today} className="field-input min-h-10 !rounded-md !py-1.5" value={value.to} onChange={(e) => setCustom(value.from, e.target.value)} />
          </div>
          {error && <p role="alert" className="pb-2 text-sm font-semibold text-danger">{error}</p>}
        </div>
      )}
    </div>
  )
}

// ---- KPI card -----------------------------------------------------------------
export function Delta({ value, invert = false, label = 'vs previous period' }: { value: number | null; invert?: boolean; label?: string }) {
  if (value === null) return <span className="text-xs text-subtle">No data for {label.replace('vs ', '')}</span>
  const flat = Math.abs(value) < 0.01
  const up = value > 0
  const good = invert ? !up : up
  const tone = flat ? 'text-subtle' : good ? 'text-ready' : 'text-danger'
  return (
    <span className={`text-xs font-semibold ${tone}`}>
      <span aria-hidden="true">{flat ? '■' : up ? '▲' : '▼'} </span>
      <span className="sr-only">{flat ? 'No change' : up ? 'Up' : 'Down'} </span>
      {percent(Math.abs(value))}
      <span className="font-normal text-subtle"> {label}</span>
    </span>
  )
}

export function KpiCard({
  label, value, delta, invert, hint, emphasis = false,
}: { label: string; value: ReactNode; delta?: number | null; invert?: boolean; hint?: ReactNode; emphasis?: boolean }) {
  return (
    <div className={`card min-w-0 p-4 ${emphasis ? 'border-ink/20' : ''}`}>
      <p className="truncate text-[13px] font-semibold text-muted">{label}</p>
      <p className="tabular mt-1 truncate text-[26px] leading-tight font-extrabold tracking-tight">{value}</p>
      <div className="mt-1.5 min-h-4">
        {delta !== undefined && <Delta value={delta} invert={invert} />}
        {hint && <p className="text-xs text-subtle">{hint}</p>}
      </div>
    </div>
  )
}

export function KpiGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">{children}</div>
}

// ---- Panel ------------------------------------------------------------------
export function Panel({
  title, description, actions, children, className = '', flush = false, id,
}: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; flush?: boolean; id?: string }) {
  const headingId = useId()
  return (
    <section className={`card min-w-0 overflow-hidden ${className}`} aria-labelledby={title ? headingId : undefined} id={id}>
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3 sm:px-5">
          <div className="min-w-0">
            {title && <h2 id={headingId} className="text-[15px] font-extrabold">{title}</h2>}
            {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={flush ? '' : 'p-4 sm:p-5'}>{children}</div>
    </section>
  )
}

/** Horizontally scrollable wrapper for wide tables (keyboard-focusable for screen readers and axe). */
export function TableScroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="overflow-x-auto" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  )
}

// ---- Loading ----------------------------------------------------------------
export function SkeletonRows({ rows = 5, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-3 p-4 sm:p-5">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4">
          <div className="skeleton h-4 flex-1" />
          <div className="skeleton h-4 w-20" />
        </div>
      ))}
    </div>
  )
}

export function SkeletonKpis() {
  return (
    <div role="status" aria-label="Loading figures" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="card space-y-3 p-4">
          <div className="skeleton h-3.5 w-24" />
          <div className="skeleton h-7 w-28" />
          <div className="skeleton h-3 w-32" />
        </div>
      ))}
    </div>
  )
}

/** Status pill for stock: OK / Low / Out. Amber and red are distinct from the brand yellow. */
export function StockBadge({ onHand, lowAt }: { onHand: number; lowAt: number }) {
  if (onHand <= 0) return <span className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-xs font-bold text-danger">Out of stock</span>
  if (onHand <= lowAt) return <span className="inline-flex items-center gap-1 rounded-full bg-[#fdf0dc] px-2 py-0.5 text-xs font-bold text-[#8a4b00]">Low</span>
  return <span className="inline-flex items-center gap-1 rounded-full bg-ready-soft px-2 py-0.5 text-xs font-bold text-ready">In stock</span>
}
