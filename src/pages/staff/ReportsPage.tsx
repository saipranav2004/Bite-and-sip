import { useCallback, useEffect, useState } from 'react'
import { backend } from '../../backend'
import { KpiCard, KpiGrid, PageBody, PageHeader, Panel, PeriodPicker, SkeletonKpis, SkeletonRows, periodLabel, usePeriod } from '../../components/admin'
import { IconDownload } from '../../components/icons'
import { Banner, Button, PaymentBadge, StatusBadge } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { addDays, cafeDate, formatDay, hourLabel, money, orderCode, timeOfDay } from '../../lib/format'
import { paymentDisplay } from '../../lib/orderRules'
import { change, previousPeriod } from '../../lib/pnl'
import { ordersToCsv } from '../../lib/reports'
import type { SalesSummary, StaffOrder } from '../../lib/types'

export function ReportsPage() {
  const [period, setPeriod] = usePeriod('sales', 'today')
  const [summary, setSummary] = useState<SalesSummary | null>(null)
  const [prev, setPrev] = useState<SalesSummary | null>(null)
  const [orders, setOrders] = useState<StaffOrder[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const range = { from: period.from, to: period.to }

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const p = previousPeriod(period.from, period.to)
      const [s, o, ps] = await Promise.all([
        backend.salesSummary(period.from, period.to),
        backend.listOrdersInRange(period.from, period.to),
        backend.salesSummary(p.from, p.to).catch(() => null),
      ])
      setSummary(s)
      setOrders(o)
      setPrev(ps)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setLoading(false)
    }
  }, [period.from, period.to])

  useEffect(() => {
    void load()
  }, [load])

  function downloadCsv() {
    if (!orders) return
    const blob = new Blob([ordersToCsv(orders)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `bite-and-sip-orders-${range.from}-to-${range.to}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const delta = (k: 'sales' | 'orders' | 'average_order_value') => (summary && prev ? change(summary[k], prev[k]) : undefined)

  return (
    <PageBody>
      <PageHeader
        title="Sales"
        subtitle={`${periodLabel(period)} · India time · based on when orders were placed`}
        actions={
          <Button variant="secondary" size="sm" onClick={downloadCsv} disabled={!orders?.length}>
            <IconDownload size={16} /> Download CSV
          </Button>
        }
      >
        <PeriodPicker value={period} onChange={setPeriod} maxDays={92} />
      </PageHeader>

      {error && <Banner tone="danger" className="mb-4" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}>{error}</Banner>}

      {loading && !summary ? (
        <div className="space-y-4">
          <SkeletonKpis />
          <div className="card"><SkeletonRows rows={6} label="Loading report" /></div>
        </div>
      ) : summary ? (
        <div className={`space-y-4 transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
          <KpiGrid>
            <KpiCard label="Sales" value={money(summary.sales)} delta={delta('sales')} emphasis />
            <KpiCard label="Orders" value={String(summary.orders)} delta={delta('orders')} />
            <KpiCard label="Average order" value={money(summary.average_order_value)} delta={delta('average_order_value')} />
            <KpiCard label="Open right now" value={String(summary.open_orders)} hint={summary.open_orders ? 'Not yet collected' : 'All collected'} />
          </KpiGrid>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Where the money is" description="Only payments staff confirmed count as received.">
              <dl className="divide-y divide-line text-[15px]">
                <Row label="Cash collected" value={summary.cash_collected} />
                <Row label="UPI confirmed by staff" value={summary.upi_confirmed} />
                <Row label="Cash not yet collected" value={summary.outstanding_cash} muted />
                <Row
                  label="UPI not yet confirmed"
                  value={summary.outstanding_upi}
                  muted
                  note={summary.upi_awaiting_verification ? `${summary.upi_awaiting_verification} waiting for a staff check` : undefined}
                />
                <div className="flex items-center justify-between pt-3 font-extrabold">
                  <dt>Sales</dt>
                  <dd className="tabular">{money(summary.sales)}</dd>
                </div>
              </dl>
              <p className="mt-2 text-xs text-muted">Cash collected + UPI confirmed + not yet paid = sales.</p>
            </Panel>

            <Panel title="Cancellations & refunds" description="Cancelled orders are not counted in sales.">
              <dl className="divide-y divide-line text-[15px]">
                <div className="flex items-center justify-between py-2">
                  <dt>Cancelled orders</dt>
                  <dd className="tabular font-bold">{summary.cancelled_orders} · {money(summary.cancelled_value)}</dd>
                </div>
                <div className="flex items-center justify-between py-2">
                  <dt>Refunds due <span className="text-sm text-muted">(paid, then cancelled)</span></dt>
                  <dd className={`tabular font-bold ${summary.refunds_due ? 'text-danger' : ''}`}>
                    {summary.refunds_due_count} · {money(summary.refunds_due)}
                  </dd>
                </div>
              </dl>
            </Panel>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <Panel title={range.from === range.to ? 'Sales by hour' : 'Sales by day'}>
              {range.from === range.to ? (
                <BarChart data={hoursFor(summary.by_hour)} />
              ) : (
                <BarChart
                  data={enumerateDays(range.from, range.to).map((d) => {
                    const row = summary.by_day.find((x) => x.day === d)
                    return { key: d, label: formatDay(d).replace(/^\w+, /, ''), value: row?.sales ?? 0, detail: `${row?.orders ?? 0} orders` }
                  })}
                />
              )}
            </Panel>

            <Panel title="Top items" flush>
              {summary.top_items.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted">No sales in this period.</p>
              ) : (
                <table className="dt">
                  <thead>
                    <tr>
                      <th scope="col">Item</th>
                      <th scope="col" className="num">Qty</th>
                      <th scope="col" className="num">Sales</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.top_items.map((t) => (
                      <tr key={t.name}>
                        <td className="font-semibold">{t.name}</td>
                        <td className="num">{t.quantity}</td>
                        <td className="num">{money(t.sales)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          </div>

          <OrdersTable orders={orders ?? []} />
        </div>
      ) : null}
    </PageBody>
  )
}

/** A full trading day (8am–8pm, widened if orders fall outside), so quiet hours show as gaps. */
function hoursFor(rows: SalesSummary['by_hour']) {
  const first = Math.min(8, ...rows.map((r) => r.hour))
  const last = Math.max(20, ...rows.map((r) => r.hour))
  const out = []
  for (let h = first; h <= last; h++) {
    const r = rows.find((x) => x.hour === h)
    out.push({ key: String(h), label: hourLabel(h), value: r?.sales ?? 0, detail: `${r?.orders ?? 0} orders` })
  }
  return out
}

function enumerateDays(from: string, to: string) {
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}

function Row({ label, value, muted, note }: { label: string; value: number; muted?: boolean; note?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <dt className={muted ? 'text-ink-2' : 'font-semibold'}>
        {label}
        {note && <span className="block text-xs font-bold text-brand-ink">{note}</span>}
      </dt>
      <dd className="tabular font-bold">{money(value)}</dd>
    </div>
  )
}

/** Single-series bar chart. Bars carry their values in tooltips and in an accessible table. */
function BarChart({ data }: { data: { key: string; label: string; value: number; detail: string }[] }) {
  const [active, setActive] = useState<string | null>(null)
  if (data.length === 0 || data.every((d) => d.value === 0)) return <p className="py-10 text-center text-sm text-muted">No sales in this period.</p>
  const max = Math.max(...data.map((d) => d.value))
  const step = niceStep(max)
  const top = Math.ceil(max / step) * step
  const ticks = Array.from({ length: Math.floor(top / step) + 1 }, (_, i) => i * step)
  const showEvery = data.length > 7 ? Math.ceil(data.length / 6) : 1
  const current = data.find((d) => d.key === active)

  return (
    <figure className="mt-3">
      <div className="relative h-56 pl-12">
        {ticks.map((t) => (
          <div key={t} className="absolute right-0 left-12 border-t border-line" style={{ bottom: `${(t / top) * 100}%` }} aria-hidden="true">
            <span className="tabular absolute -top-2 -left-12 w-10 text-right text-[11px] text-muted">{t >= 1000 ? `${t / 1000}k` : t}</span>
          </div>
        ))}
        <div className="absolute inset-y-0 right-0 left-12 flex items-end gap-[2px]">
          {data.map((d) => (
            <button
              key={d.key}
              type="button"
              className="group relative flex h-full min-w-0 flex-1 items-end focus:outline-none"
              onMouseEnter={() => setActive(d.key)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(d.key)}
              onBlur={() => setActive(null)}
              aria-label={`${d.label}: ${money(d.value)}, ${d.detail}`}
            >
              <span
                className={`block w-full max-w-10 mx-auto rounded-t-[4px] transition-colors ${active === d.key ? 'bg-brand ring-2 ring-ink' : 'bg-ink-2'}`}
                style={{ height: `${(d.value / top) * 100}%`, minHeight: d.value ? 2 : 0 }}
              />
            </button>
          ))}
        </div>
        {current && (
          <div className="pointer-events-none absolute top-0 right-0 rounded-xl bg-ink px-3 py-2 text-sm text-white shadow-[var(--shadow-float)]" role="status">
            <span className="font-bold">{current.label}</span> · <span className="tabular">{money(current.value)}</span>
            <span className="block text-xs text-white/70">{current.detail}</span>
          </div>
        )}
      </div>
      <div className="mt-1 flex gap-[2px] pl-12" aria-hidden="true">
        {data.map((d, i) => (
          <span key={d.key} className="min-w-0 flex-1 overflow-hidden text-center text-[11px] whitespace-nowrap text-muted">{i % showEvery === 0 ? d.label : ''}</span>
        ))}
      </div>
      <figcaption className="sr-only">Sales per period. Hover or focus a bar for its value.</figcaption>
    </figure>
  )
}

function niceStep(max: number) {
  if (max <= 0) return 1
  const raw = max / 4
  const pow = 10 ** Math.floor(Math.log10(raw))
  const n = raw / pow
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow
}

function OrdersTable({ orders }: { orders: StaffOrder[] }) {
  const [showAll, setShowAll] = useState(false)
  const list = showAll ? orders : orders.slice(0, 25)
  return (
    <section className="card overflow-hidden" aria-labelledby="orders-h">
      <div className="flex items-center justify-between border-b border-line px-4 py-3 sm:px-5">
        <h2 id="orders-h" className="text-[15px] font-extrabold">Orders ({orders.length})</h2>
      </div>
      {orders.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">No orders in this period.</p>
      ) : (
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Orders table (scrolls sideways)">
          <table className="dt min-w-[720px]">
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Placed</th>
                <th scope="col">Customer</th>
                <th scope="col">Status</th>
                <th scope="col">Payment</th>
                <th scope="col" className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {list.map((o) => (
                <tr key={o.id}>
                  <td className="tabular font-bold">{orderCode(o.order_no)}</td>
                  <td className="tabular whitespace-nowrap text-muted">{formatDay(cafeDate(new Date(o.created_at)))}, {timeOfDay(o.created_at)}</td>
                  <td>{o.customer_name}</td>
                  <td><StatusBadge status={o.status} /></td>
                  <td>
                    {o.status === 'cancelled' && o.payment_status === 'paid' ? (
                      <span className="text-xs font-bold text-danger">Refund due</span>
                    ) : o.status === 'cancelled' ? (
                      <span className="text-xs text-muted">—</span>
                    ) : (
                      <PaymentBadge display={paymentDisplay(o)} method={o.payment_method} />
                    )}
                  </td>
                  <td className={`num font-bold ${o.status === 'cancelled' ? 'text-muted line-through' : ''}`}>{money(o.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {orders.length > 25 && (
        <div className="border-t border-line p-3 text-center">
          <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show fewer' : `Show all ${orders.length}`}</Button>
        </div>
      )}
    </section>
  )
}
