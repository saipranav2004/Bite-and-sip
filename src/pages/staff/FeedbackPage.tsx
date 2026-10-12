// What students say after they're served: average rating, spread, and comments.
import { useEffect, useMemo, useState } from 'react'
import { backend } from '../../backend'
import { KpiCard, KpiGrid, PageBody, PageHeader, Panel, PeriodPicker, SkeletonKpis, SkeletonRows, periodLabel, usePeriod } from '../../components/admin'
import { IconStar } from '../../components/icons'
import { Banner, Button, EmptyState } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { dateTime, orderCode, percent } from '../../lib/format'
import type { FeedbackEntry } from '../../lib/types'

type Filter = 'all' | 'low' | 'comments'

export function FeedbackPage() {
  const [period, setPeriod] = usePeriod('feedback', '30d')
  const [rows, setRows] = useState<FeedbackEntry[] | null>(null)
  const [orders, setOrders] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    setRows(null)
    setError(null)
    Promise.all([backend.listFeedback(period.from, period.to), backend.salesSummary(period.from, period.to).catch(() => null)]).then(
      ([f, s]) => {
        if (!alive) return
        setRows(f)
        setOrders(s ? s.completed_orders : null)
      },
      (e) => alive && setError(friendlyError(e)),
    )
    return () => {
      alive = false
    }
  }, [period.from, period.to, attempt])

  const stats = useMemo(() => {
    if (!rows) return null
    const n = rows.length
    const avg = n ? rows.reduce((s, r) => s + r.rating, 0) / n : null
    const dist = [5, 4, 3, 2, 1].map((star) => ({ star, count: rows.filter((r) => r.rating === star).length }))
    return { n, avg, dist, low: rows.filter((r) => r.rating <= 2).length, comments: rows.filter((r) => r.comment).length }
  }, [rows])

  const shown = (rows ?? []).filter((r) => (filter === 'low' ? r.rating <= 3 : filter === 'comments' ? !!r.comment : true))

  return (
    <PageBody>
      <PageHeader title="Feedback" subtitle="Ratings students leave after they’re served or collect their order.">
        <PeriodPicker value={period} onChange={setPeriod} maxDays={366} />
      </PageHeader>
      {error && <Banner tone="danger" className="mb-4" action={<Button size="sm" variant="secondary" onClick={() => setAttempt((a) => a + 1)}>Retry</Button>}>{error}</Banner>}

      {!stats ? (
        <SkeletonKpis />
      ) : (
        <KpiGrid>
          <KpiCard label="Average rating" value={stats.avg === null ? '—' : `${stats.avg.toFixed(1)} / 5`} hint={periodLabel(period)} emphasis />
          <KpiCard label="Ratings" value={String(stats.n)} hint={orders ? `${percent(stats.n / orders, 0)} of ${orders} completed orders` : undefined} />
          <KpiCard label="Unhappy (1–2 ★)" value={String(stats.low)} hint={stats.n ? percent(stats.low / stats.n, 0) : undefined} />
          <KpiCard label="With a comment" value={String(stats.comments)} />
        </KpiGrid>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-[320px_1fr]">
        <Panel title="Spread">
          {!stats ? (
            <SkeletonRows rows={5} />
          ) : (
            <ul className="space-y-2">
              {stats.dist.map((d) => (
                <li key={d.star} className="flex items-center gap-3 text-sm">
                  <span className="inline-flex w-10 items-center gap-1 font-bold">{d.star} <IconStar size={13} className="text-brand-strong" /></span>
                  <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-sunken">
                    <span className="block h-full rounded-full bg-ink" style={{ width: `${stats.n ? (d.count / stats.n) * 100 : 0}%` }} />
                  </span>
                  <span className="tabular w-8 text-right text-muted">{d.count}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="What they said"
          flush
          actions={
            <div className="inline-flex gap-1 rounded-lg border border-line p-1" role="group" aria-label="Show">
              {([['all', 'All'], ['low', '3 ★ or less'], ['comments', 'With comments']] as [Filter, string][]).map(([f, l]) => (
                <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className={`min-h-8 rounded-md px-2.5 text-sm font-semibold ${filter === f ? 'bg-ink text-white' : 'text-ink-2 hover:bg-sunken'}`}>{l}</button>
              ))}
            </div>
          }
        >
          {!rows ? (
            <SkeletonRows rows={4} />
          ) : shown.length === 0 ? (
            <EmptyState title={rows.length ? 'Nothing matches this filter' : 'No ratings in this period'}>
              Students see a “How was it?” card on their order page after it’s served.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {shown.map((r) => (
                <li key={r.order_id} className="px-4 py-3 sm:px-5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="flex" role="img" aria-label={`${r.rating} out of 5`}>
                      {[1, 2, 3, 4, 5].map((n) => <IconStar key={n} size={15} className={n <= r.rating ? 'text-brand-strong' : 'text-line-strong'} />)}
                    </span>
                    <span className="tabular text-sm font-bold">{orderCode(r.order_no)}</span>
                    <span className="text-sm text-muted">{r.customer_name}{r.table_label ? ` · Table ${r.table_label}` : ''}</span>
                    <span className="ml-auto text-xs text-subtle">{dateTime(r.created_at)}</span>
                  </div>
                  {r.comment && <p className={`mt-1 text-[15px] ${r.rating <= 2 ? 'font-semibold' : ''}`}>“{r.comment}”</p>}
                  <p className="mt-0.5 truncate text-xs text-muted">{r.items}</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </PageBody>
  )
}
