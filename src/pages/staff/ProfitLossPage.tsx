import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { backend } from '../../backend'
import {
  KpiCard, KpiGrid, PageBody, PageHeader, Panel, PeriodPicker, SkeletonKpis, SkeletonRows, TableScroll, periodLabel, usePeriod,
} from '../../components/admin'
import { IconDownload } from '../../components/icons'
import { Banner, Button } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { money, percent, signedMoney } from '../../lib/format'
import { buildStatement, change, previousPeriod, type FoodCostMethod, type Statement } from '../../lib/pnl'
import { readJson, writeJson } from '../../lib/storage'
import type { ProfitAndLossData } from '../../lib/types'

const METHOD_KEY = 'bitesip-pnl-method'

type ItemSort = 'profit' | 'margin' | 'sales'

export function ProfitLossPage() {
  const [period, setPeriod] = usePeriod('pnl', 'month')
  const [method, setMethodState] = useState<FoodCostMethod>(() => readJson<FoodCostMethod>(METHOD_KEY, 'item_costs'))
  const [data, setData] = useState<{ cur: ProfitAndLossData; prev: ProfitAndLossData } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [compare, setCompare] = useState(true)
  const [sort, setSort] = useState<ItemSort>('profit')
  const [attempt, setAttempt] = useState(0)

  const setMethod = (m: FoodCostMethod) => {
    setMethodState(m)
    writeJson(METHOD_KEY, m)
  }

  useEffect(() => {
    let alive = true
    setData(null)
    setError(null)
    const prev = previousPeriod(period.from, period.to)
    Promise.all([backend.profitAndLoss(period.from, period.to), backend.profitAndLoss(prev.from, prev.to)]).then(
      ([cur, p]) => alive && setData({ cur, prev: p }),
      (e) => alive && setError(friendlyError(e)),
    )
    return () => {
      alive = false
    }
  }, [period.from, period.to, attempt])

  const st = useMemo(() => (data ? buildStatement(data.cur, method) : null), [data, method])
  const pst = useMemo(() => (data ? buildStatement(data.prev, method) : null), [data, method])

  function exportCsv() {
    if (!data || !st) return
    const rows: (string | number)[][] = [
      ['Bite & Sip profit & loss', `${data.cur.from} to ${data.cur.to}`],
      ['Food cost based on', method === 'item_costs' ? 'Item costs' : 'Ingredient purchases'],
      [],
      ['Line', 'Amount (₹)', '% of sales'],
      ['Sales', st.sales, pct(st.sales, st.sales)],
      ['Food cost', -st.foodCost, pct(st.foodCost, st.sales)],
      ['Gross profit', st.grossProfit, pct(st.grossProfit, st.sales)],
      ...st.operating.map((l) => [l.label, -l.amount, pct(l.amount, st.sales)]),
      ['Total operating expenses', -st.operatingTotal, pct(st.operatingTotal, st.sales)],
      ...(method === 'item_costs' ? [['Waste (at cost)', -st.waste, pct(st.waste, st.sales)]] : []),
      ['Net profit', st.netProfit, pct(st.netProfit, st.sales)],
      [],
      ['Item', 'Sold', 'Sales (₹)', 'Cost (₹)', 'Profit (₹)', 'Margin'],
      ...data.cur.items.map((i) => [i.name, i.quantity, i.sales, i.cost ?? 'not set', i.cost === null ? '' : i.sales - i.cost, i.cost === null ? '' : pct(i.sales - i.cost, i.sales)]),
    ]
    const csv = rows.map((r) => r.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }))
    a.download = `bite-and-sip-profit-${data.cur.from}-to-${data.cur.to}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const items = useMemo(() => {
    if (!data) return []
    const rows = data.cur.items.map((i) => ({ ...i, profit: i.cost === null ? null : i.sales - i.cost }))
    const key = (r: (typeof rows)[number]) =>
      sort === 'sales' ? r.sales : sort === 'profit' ? (r.profit ?? -Infinity) : r.profit === null || r.sales === 0 ? -Infinity : r.profit / r.sales
    return rows.sort((a, b) => key(b) - key(a) || a.name.localeCompare(b.name))
  }, [data, sort])

  return (
    <PageBody>
      <PageHeader
        title="Profit & loss"
        subtitle="What the café earned after food costs and running costs."
        actions={<Button size="sm" variant="secondary" onClick={exportCsv} disabled={!data}><IconDownload size={16} /> Export CSV</Button>}
      >
        <PeriodPicker value={period} onChange={setPeriod} maxDays={366} />
      </PageHeader>

      {error && <Banner tone="danger" className="mb-4" action={<Button size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>}>{error}</Banner>}

      {!data || !st || !pst ? (
        !error && (
          <div className="space-y-4">
            <SkeletonKpis />
            <div className="card"><SkeletonRows rows={8} label="Loading statement" /></div>
          </div>
        )
      ) : (
        <div className="space-y-4">
          {st.foodCostIncomplete && (
            <Banner
              tone="warning"
              title="Food cost is incomplete"
              action={<Link to="/staff/menu" className="inline-flex min-h-9 items-center rounded-lg bg-ink px-3 text-sm font-bold text-white">Set costs</Link>}
            >
              {data.cur.uncosted_items} {data.cur.uncosted_items === 1 ? 'item' : 'items'} sold without a cost ({money(data.cur.uncosted_sales)} of sales), so profit below is higher than it really is.
            </Banner>
          )}

          <KpiGrid>
            <KpiCard label="Sales" value={money(st.sales)} delta={change(st.sales, pst.sales)} />
            <KpiCard label="Gross profit" value={signedMoney(st.grossProfit)} delta={change(st.grossProfit, pst.grossProfit)} />
            <KpiCard label="Net profit" value={signedMoney(st.netProfit)} delta={change(st.netProfit, pst.netProfit)} emphasis />
            <KpiCard
              label="Net margin"
              value={`${st.foodCostIncomplete ? '≈ ' : ''}${percent(st.netMargin)}`}
              hint={st.primeCost !== null ? `Prime cost ${percent(st.primeCost)} of sales (aim under 65%)` : undefined}
            />
          </KpiGrid>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <Panel
              title="Statement"
              description={`${periodLabel(period)} · food cost from ${method === 'item_costs' ? 'item costs' : 'ingredient purchases'}`}
              actions={
                <label className="inline-flex items-center gap-2 text-sm font-semibold">
                  <input type="checkbox" className="size-4 accent-ink" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
                  Compare with previous period
                </label>
              }
              flush
            >
              <TableScroll label="Profit and loss statement">
                <StatementTable st={st} prev={compare ? pst : null} />
              </TableScroll>
              {data.cur.outstanding > 0 && (
                <p className="border-t border-line px-5 py-3 text-xs text-muted">
                  Sales include {money(data.cur.outstanding)} not collected yet (orders still open or unpaid).
                </p>
              )}
            </Panel>

            <div className="space-y-4">
              <Panel title="Food cost based on">
                <div className="space-y-2" role="radiogroup" aria-label="Food cost based on">
                  {([
                    ['item_costs', 'Item costs', 'Quantity sold × the cost you set on each item. Gives per-item margins.'],
                    ['purchases', 'Ingredient purchases', 'What you logged under “Ingredients & groceries” in Expenses.'],
                  ] as [FoodCostMethod, string, string][]).map(([value, label, help]) => (
                    <label key={value} className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${method === value ? 'border-ink ring-1 ring-ink' : 'border-line-strong'}`}>
                      <input type="radio" name="food-cost" className="mt-1 size-4 accent-ink" checked={method === value} onChange={() => setMethod(value)} />
                      <span>
                        <span className="block text-sm font-bold">{label}{value === 'item_costs' && <span className="font-normal text-muted"> · recommended</span>}</span>
                        <span className="block text-xs text-muted">{help}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <p className="mt-3 text-xs text-muted">Only one is counted, so ingredients are never subtracted twice.</p>
              </Panel>
              {method === 'item_costs' && <FoodCostCheck st={st} />}
            </div>
          </div>

          <Panel
            title="Profit by item"
            description="Based on the cost recorded when each order was placed."
            actions={
              <label className="inline-flex items-center gap-2 text-sm">
                <span className="text-muted">Sort by</span>
                <select className="field-input !min-h-9 !w-auto !rounded-md !py-1 text-sm" value={sort} onChange={(e) => setSort(e.target.value as ItemSort)}>
                  <option value="profit">Profit</option>
                  <option value="margin">Margin</option>
                  <option value="sales">Sales</option>
                </select>
              </label>
            }
            flush
          >
            {items.length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-muted">No sales in this period.</p>
            ) : (
              <TableScroll label="Profit by item">
                <table className="dt min-w-[560px]">
                  <thead>
                    <tr>
                      <th scope="col">Item</th>
                      <th scope="col" className="num">Sold</th>
                      <th scope="col" className="num">Sales</th>
                      <th scope="col" className="num">Cost</th>
                      <th scope="col" className="num">Profit</th>
                      <th scope="col" className="num">Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((i) => (
                      <tr key={i.name}>
                        <td className="font-semibold">{i.name}</td>
                        <td className="num">{i.quantity}</td>
                        <td className="num">{money(i.sales)}</td>
                        <td className="num">
                          {i.cost === null ? <Link to="/staff/menu" className="font-semibold text-[#8a4b00] underline">Set cost</Link> : money(i.cost)}
                        </td>
                        <td className={`num font-bold ${i.profit !== null && i.profit < 0 ? 'text-danger' : ''}`}>{i.profit === null ? '—' : signedMoney(i.profit)}</td>
                        <td className="num">{i.profit === null ? '—' : percent(i.sales ? i.profit / i.sales : null)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </Panel>
        </div>
      )}
    </PageBody>
  )
}

const PROFIT_LINES = ['Gross profit', 'Net profit']
const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '')

function StatementTable({ st, prev }: { st: Statement; prev: Statement | null }) {
  const est = st.foodCostIncomplete
  type Row = { label: string; cur: number; prev?: number; kind?: 'sub' | 'total' | 'muted' | 'cost' | 'head'; tag?: string; indent?: boolean }
  const prevOp = (key: string) => prev?.operating.find((o) => o.key === key)?.amount ?? 0
  const rows: Row[] = [
    { label: 'Sales', cur: st.sales, prev: prev?.sales },
    { label: 'Food cost', cur: -st.foodCost, prev: prev ? -prev.foodCost : undefined, kind: 'cost', tag: est ? 'est.' : undefined },
    { label: 'Gross profit', cur: st.grossProfit, prev: prev?.grossProfit, kind: 'sub' },
    { label: 'Operating expenses', cur: NaN, kind: 'head' },
    ...st.operating.map((o) => ({ label: o.label, cur: -o.amount, prev: prev ? -prevOp(o.key) : undefined, kind: 'cost' as const, indent: true })),
    ...(st.operating.length === 0 ? [{ label: 'None logged', cur: 0, kind: 'muted' as const, indent: true }] : []),
    { label: 'Total operating expenses', cur: -st.operatingTotal, prev: prev ? -prev.operatingTotal : undefined, kind: 'sub' },
    ...(st.method === 'item_costs' ? [{ label: 'Waste (at cost)', cur: -st.waste, prev: prev ? -prev.waste : undefined, kind: 'cost' as const }] : []),
    { label: 'Net profit', cur: st.netProfit, prev: prev?.netProfit, kind: 'total' },
  ]
  return (
    <table className="dt min-w-[420px]">
      <thead>
        <tr>
          <th scope="col">Line</th>
          <th scope="col" className="num">Amount</th>
          <th scope="col" className="num">% of sales</th>
          {prev && <th scope="col" className="num">Previous</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) =>
          r.kind === 'head' ? (
            <tr key={r.label}>
              <th scope="row" colSpan={prev ? 4 : 3} className="!bg-surface !pt-4 text-left !text-[12px] !text-muted uppercase">{r.label}</th>
            </tr>
          ) : (
            <tr key={r.label} className={r.kind === 'total' ? 'text-[16px]' : ''}>
              <th
                scope="row"
                className={`!bg-transparent text-left !text-[14px] !normal-case ${r.kind === 'sub' || r.kind === 'total' ? '!font-extrabold !text-ink' : '!font-medium !text-ink-2'} ${r.indent ? 'pl-6' : ''} ${
                  r.kind === 'sub' ? 'border-t border-line-strong' : r.kind === 'total' ? 'border-t-[3px] border-double border-ink/40' : ''
                }`}
              >
                {r.label}
                {r.tag && <span className="ml-2 rounded bg-[#fdf0dc] px-1.5 py-0.5 text-[11px] font-bold text-[#8a4b00]">{r.tag}</span>}
              </th>
              <td
                className={`num ${r.kind === 'sub' || r.kind === 'total' ? 'font-extrabold' : ''} ${r.cur < 0 && PROFIT_LINES.includes(r.label) ? 'text-danger' : ''} ${
                  r.kind === 'sub' ? 'border-t border-line-strong' : r.kind === 'total' ? 'border-t-[3px] border-double border-ink/40' : ''
                } ${r.kind === 'muted' ? 'text-subtle' : ''}`}
              >
                {r.kind === 'muted' ? '—' : signedMoney(r.cur)}
              </td>
              <td className={`num text-muted ${r.kind === 'sub' ? 'border-t border-line-strong' : r.kind === 'total' ? 'border-t-[3px] border-double border-ink/40' : ''}`}>
                {r.kind === 'muted' || st.sales <= 0 ? '' : `${est && ['Food cost', 'Gross profit', 'Net profit'].includes(r.label) ? '≈ ' : ''}${PROFIT_LINES.includes(r.label) ? percent(r.cur / st.sales) : pct(Math.abs(r.cur), st.sales)}`}
              </td>
              {prev && (
                <td className={`num text-muted ${r.kind === 'sub' ? 'border-t border-line-strong' : r.kind === 'total' ? 'border-t-[3px] border-double border-ink/40' : ''}`}>
                  {r.prev === undefined ? '' : signedMoney(r.prev)}
                </td>
              )}
            </tr>
          ),
        )}
      </tbody>
    </table>
  )
}

function FoodCostCheck({ st }: { st: Statement }) {
  const gap = st.purchases - st.foodCost
  const ratio = st.foodCost > 0 ? gap / st.foodCost : null
  return (
    <Panel title="Food cost check">
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between gap-3"><dt className="text-muted">Ingredients bought</dt><dd className="tabular font-bold">{money(st.purchases)}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted">Used, by item costs</dt><dd className="tabular font-bold">{money(st.foodCost)}</dd></div>
        <div className="flex justify-between gap-3 border-t border-line pt-2"><dt className="text-muted">Difference</dt><dd className="tabular font-bold">{signedMoney(gap)}</dd></div>
      </dl>
      <p className="mt-3 text-xs text-muted">
        {st.purchases === 0
          ? 'Log ingredient purchases in Expenses to compare them with what your item costs say you used.'
          : ratio !== null && ratio > 0.2
            ? 'You bought noticeably more than your item costs account for. Costs may be set too low, or stock is building up or being wasted.'
            : ratio !== null && ratio < -0.2
              ? 'You bought less than your item costs say you used. Costs may be set too high, or purchases are missing from Expenses.'
              : 'Purchases and item costs roughly agree. Small gaps are normal: stock carries over between periods.'}
      </p>
    </Panel>
  )
}
