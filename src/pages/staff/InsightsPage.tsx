// Menu insights (menu engineering): which items earn their place on the menu.
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { backend } from '../../backend'
import { PageBody, PageHeader, Panel, PeriodPicker, SkeletonRows, TableScroll, usePeriod } from '../../components/admin'
import { Banner, Button } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { money, percent } from '../../lib/format'
import { CLASS_INFO, menuEngineering, type MenuClass } from '../../lib/insights'
import type { Costs, ProfitAndLossData } from '../../lib/types'
import { usePublicData } from '../../state/publicData'

const ORDER: MenuClass[] = ['star', 'plowhorse', 'puzzle', 'dog']
const TONE: Record<MenuClass, string> = {
  star: 'border-ready/40 bg-ready-soft',
  plowhorse: 'border-brand-strong/50 bg-brand-soft',
  puzzle: 'border-placed/30 bg-placed-soft',
  dog: 'border-danger/25 bg-danger-soft',
  unknown: 'border-line bg-sunken',
}

export function InsightsPage() {
  const { data } = usePublicData()
  const [period, setPeriod] = usePeriod('insights', '30d')
  const [pnl, setPnl] = useState<ProfitAndLossData | null>(null)
  const [costs, setCosts] = useState<Costs | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    setPnl(null)
    setError(null)
    Promise.all([backend.profitAndLoss(period.from, period.to), backend.getCosts()]).then(
      ([p, c]) => {
        if (!alive) return
        setPnl(p)
        setCosts(c)
      },
      (e) => alive && setError(friendlyError(e)),
    )
    return () => {
      alive = false
    }
  }, [period.from, period.to, attempt])

  const insights = useMemo(
    () => (pnl && costs && data ? menuEngineering(pnl.items, data.menu.items, costs) : null),
    [pnl, costs, data],
  )
  const unknown = insights?.rows.filter((r) => r.klass === 'unknown') ?? []

  return (
    <PageBody>
      <PageHeader title="Menu insights" subtitle="Which items are popular, which earn the most, and what to do about the rest.">
        <PeriodPicker value={period} onChange={setPeriod} maxDays={366} />
      </PageHeader>
      {error && <Banner tone="danger" className="mb-4" action={<Button size="sm" variant="secondary" onClick={() => setAttempt((a) => a + 1)}>Retry</Button>}>{error}</Banner>}

      {!insights ? (
        <Panel><SkeletonRows rows={6} label="Working out insights" /></Panel>
      ) : insights.totalUnits === 0 ? (
        <Banner tone="info">No sales in this period yet. Pick a longer period.</Banner>
      ) : (
        <>
          <p className="mb-3 text-sm text-muted">
            An item is <strong className="text-ink">popular</strong> when it sells at least {Math.ceil(insights.popularAt)} in this period (70 % of an equal share).
            {insights.averageMargin !== null && <> It is <strong className="text-ink">profitable</strong> when it earns at least {money(Math.round(insights.averageMargin))} per item (your menu’s average).</>}
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {ORDER.map((k) => {
              const rows = insights.rows.filter((r) => r.klass === k)
              return (
                <section key={k} className={`rounded-[var(--radius-card)] border p-4 ${TONE[k]}`} aria-label={CLASS_INFO[k].label}>
                  <h2 className="flex items-center justify-between font-extrabold">
                    {CLASS_INFO[k].label} <span className="tabular text-sm font-bold text-muted">{rows.length}</span>
                  </h2>
                  <p className="text-sm text-ink-2">{CLASS_INFO[k].hint}</p>
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {rows.length === 0 && <li className="text-sm text-muted">None</li>}
                    {rows.map((r) => (
                      <li key={r.name} className="rounded-full bg-surface px-2.5 py-1 text-sm font-semibold ring-1 ring-line">
                        {r.name} <span className="tabular text-muted">· {r.quantity} sold</span>
                      </li>
                    ))}
                  </ul>
                  {rows.length > 0 && <p className="mt-3 text-sm"><strong>What to do:</strong> {CLASS_INFO[k].action}</p>}
                </section>
              )
            })}
          </div>
          {unknown.length > 0 && (
            <Banner tone="warning" className="mt-3" title={`${unknown.length} item(s) have no cost set`}>
              {unknown.map((r) => r.name).join(', ')} — set what each costs to make in <Link className="font-bold underline" to="/staff/menu">Menu</Link> to place them.
            </Banner>
          )}

          <Panel title="Every item" className="mt-4" flush>
            <TableScroll label="Menu insights by item">
              <table className="dt min-w-[680px]">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Sold</th>
                    <th className="num">Share</th>
                    <th className="num">Sales</th>
                    <th className="num">Profit / item</th>
                    <th className="num">Margin</th>
                    <th>Group</th>
                  </tr>
                </thead>
                <tbody>
                  {insights.rows.map((r) => (
                    <tr key={r.name}>
                      <td className="font-semibold">{r.name}</td>
                      <td className="num">{r.quantity}</td>
                      <td className="num">{percent(r.mix, 0)}</td>
                      <td className="num">{money(r.sales)}</td>
                      <td className="num">{r.marginPerUnit === null ? '—' : money(Math.round(r.marginPerUnit))}</td>
                      <td className="num">{r.marginPct === null ? '—' : percent(r.marginPct, 0)}</td>
                      <td>{CLASS_INFO[r.klass].label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </Panel>
        </>
      )}
    </PageBody>
  )
}
