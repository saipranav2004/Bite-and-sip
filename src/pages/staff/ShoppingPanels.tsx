// Inventory → Shopping list (what to buy, from stock and how fast it's used)
// and Usage check (what recipes say was used vs what counts found).
import { useEffect, useMemo, useState } from 'react'
import { backend } from '../../backend'
import { Panel, PeriodPicker, SkeletonRows, TableScroll, usePeriod } from '../../components/admin'
import { IconCopy, IconExternal } from '../../components/icons'
import { Banner, Button, EmptyState, useToast } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { addDays, cafeDate, money, percent } from '../../lib/format'
import { readJson, writeJson } from '../../lib/storage'
import { USAGE_WINDOW_DAYS, shoppingList, usageCheck } from '../../lib/shopping'
import type { Ingredient, IngredientUsage } from '../../lib/types'
import { formatQty } from '../../lib/units'

function useIngredientData(from: string, to: string) {
  const [ingredients, setIngredients] = useState<Ingredient[] | null>(null)
  const [usage, setUsage] = useState<IngredientUsage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setUsage(null)
    Promise.all([backend.listIngredients(), backend.ingredientUsage(from, to)]).then(
      ([i, u]) => {
        if (!alive) return
        setIngredients(i)
        setUsage(u)
        setError(null)
      },
      (e) => alive && setError(friendlyError(e)),
    )
    return () => {
      alive = false
    }
  }, [from, to])
  return { ingredients, usage, error }
}

const COVER = [
  { days: 2, label: '2 days' },
  { days: 3, label: '3 days' },
  { days: 7, label: '1 week' },
]

export function ShoppingListPanel() {
  const toast = useToast()
  const today = cafeDate()
  const { ingredients, usage, error } = useIngredientData(addDays(today, -(USAGE_WINDOW_DAYS - 1)), today)
  const [cover, setCoverState] = useState(() => readJson<number>('bitesip-shopping-cover', 3))
  const [ticked, setTicked] = useState<string[]>(() => readJson<string[]>(`bitesip-shopping-ticked-${today}`, [], 'session'))
  const setCover = (d: number) => {
    setCoverState(d)
    writeJson('bitesip-shopping-cover', d)
  }
  const tick = (id: string) => {
    const next = ticked.includes(id) ? ticked.filter((x) => x !== id) : [...ticked, id]
    setTicked(next)
    writeJson(`bitesip-shopping-ticked-${today}`, next, 'session')
  }

  const rows = useMemo(() => (ingredients && usage ? shoppingList(ingredients, usage, cover) : null), [ingredients, usage, cover])
  const total = rows?.reduce((n, r) => n + (r.estimatedCost ?? 0), 0) ?? 0
  const text = rows
    ? [`Bite & Sip shopping list (${today})`, ...rows.map((r) => `• ${r.ingredient.name}: ${formatQty(r.buy, r.ingredient.display_unit)}`)].join('\n')
    : ''

  return (
    <Panel
      title="Shopping list"
      description={`Based on what you have and your average use over the last ${USAGE_WINDOW_DAYS} days`}
      actions={
        <div className="inline-flex gap-1 rounded-lg border border-line p-1" role="group" aria-label="Buy enough for">
          {COVER.map((c) => (
            <button key={c.days} type="button" aria-pressed={cover === c.days} onClick={() => setCover(c.days)} className={`min-h-8 rounded-md px-2.5 text-sm font-semibold ${cover === c.days ? 'bg-ink text-white' : 'text-ink-2 hover:bg-sunken'}`}>
              {c.label}
            </button>
          ))}
        </div>
      }
      flush
    >
      {error && <Banner tone="danger" className="m-4">{error}</Banner>}
      {!rows ? (
        <SkeletonRows rows={4} label="Working out the shopping list" />
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing to buy right now">Everything should last the next {COVER.find((c) => c.days === cover)?.label ?? `${cover} days`} and stay above its low-stock level.</EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-line">
            {rows.map((r) => {
              const done = ticked.includes(r.ingredient.id)
              return (
                <li key={r.ingredient.id}>
                  <label className={`flex min-h-14 cursor-pointer items-center gap-3 px-4 py-2.5 sm:px-5 ${done ? 'opacity-55' : ''}`}>
                    <input type="checkbox" className="size-5 shrink-0 accent-ink" checked={done} onChange={() => tick(r.ingredient.id)} />
                    <span className="min-w-0 flex-1">
                      <span className={`block font-bold ${done ? 'line-through' : ''}`}>{r.ingredient.name}</span>
                      <span className="block text-xs text-muted">
                        Have {formatQty(r.ingredient.on_hand, r.ingredient.display_unit)}
                        {r.perDay > 0 ? ` · uses ~${formatQty(r.perDay, r.ingredient.display_unit)}/day` : ''}
                        {r.reason === 'below_low' ? ' · below low-stock level' : r.daysLeft !== null ? ` · lasts ~${r.daysLeft < 1 ? 'less than a day' : `${Math.floor(r.daysLeft)} day(s)`}` : ''}
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="tabular block font-extrabold">{formatQty(r.buy, r.ingredient.display_unit)}</span>
                      {r.estimatedCost !== null && <span className="tabular block text-xs text-muted">≈ {money(r.estimatedCost)}</span>}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 sm:px-5">
            <span className="text-sm text-muted">Estimated {money(total)} at your last prices</span>
            <span className="flex-1" />
            <Button size="sm" variant="secondary" onClick={() => navigator.clipboard?.writeText(text).then(() => toast('List copied', 'success'), () => toast('Couldn’t copy', 'error'))}>
              <IconCopy size={15} /> Copy
            </Button>
            <a className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-[#1f8f4e] px-3 text-sm font-bold text-white hover:bg-[#187441]" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">
              Share on WhatsApp <IconExternal size={14} />
            </a>
          </div>
        </>
      )}
    </Panel>
  )
}

const STATUS: Record<string, { label: string; tone: string }> = {
  ok: { label: 'OK', tone: 'bg-ready-soft text-ready' },
  watch: { label: 'Check', tone: 'bg-[#fdf0dc] text-[#8a4b00]' },
  high: { label: 'High loss', tone: 'bg-danger-soft text-danger' },
  surplus: { label: 'More left than expected', tone: 'bg-placed-soft text-placed' },
  not_counted: { label: 'Not counted', tone: 'bg-sunken text-muted' },
}

export function UsageCheckPanel() {
  const [period, setPeriod] = usePeriod('usage-check', '7d')
  const { ingredients, usage, error } = useIngredientData(period.from, period.to)
  const rows = useMemo(() => (ingredients && usage ? usageCheck(ingredients, usage) : null), [ingredients, usage])
  const lost = rows?.filter((r) => r.counted && r.gap > 0).reduce((n, r) => n + (r.gapValue ?? 0), 0) ?? 0

  return (
    <div className="space-y-4">
      <PeriodPicker value={period} onChange={setPeriod} maxDays={366} />
      <Banner tone="info" title="How to read this">
        “Expected” is what your recipes, logged usage and waste account for. When you count stock, any extra that’s missing shows as a gap —
        bigger portions, spills, things not logged, or theft. Count often (Raw materials → Count) to keep this accurate.
      </Banner>
      {error && <Banner tone="danger">{error}</Banner>}
      <Panel title="Expected vs actual use" description={rows ? (lost > 0 ? `Unexplained use worth about ${money(lost)} in this period` : 'No unexplained use found in this period') : undefined} flush>
        {!rows ? (
          <SkeletonRows rows={4} />
        ) : rows.length === 0 ? (
          <EmptyState title="No usage in this period">Add recipes to menu items (Menu → edit item → Recipe) so sales use up ingredients automatically.</EmptyState>
        ) : (
          <TableScroll label="Usage check">
            <table className="dt min-w-[680px]">
              <thead>
                <tr>
                  <th>Ingredient</th>
                  <th className="num">Expected use</th>
                  <th className="num">Actual use</th>
                  <th className="num">Gap</th>
                  <th className="num">Gap value</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.ingredient.id}>
                    <td className="font-semibold">{r.ingredient.name}</td>
                    <td className="num">{formatQty(r.expected, r.ingredient.display_unit)}</td>
                    <td className="num">{r.counted ? formatQty(r.actual, r.ingredient.display_unit) : '—'}</td>
                    <td className="num">
                      {r.counted && r.gap !== 0 ? `${r.gap > 0 ? '+' : ''}${formatQty(r.gap, r.ingredient.display_unit)}` : '—'}
                      {r.counted && r.gapPct !== null && r.gap !== 0 && <span className="block text-xs text-muted">{percent(Math.abs(r.gapPct), 0)}</span>}
                    </td>
                    <td className="num">{r.counted && r.gapValue ? money(r.gapValue) : '—'}</td>
                    <td><span className={`rounded-full px-2 py-0.5 text-xs font-bold ${STATUS[r.status].tone}`}>{STATUS[r.status].label}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>
    </div>
  )
}
