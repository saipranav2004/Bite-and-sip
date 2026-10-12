// End-of-day cash count: what should be in the drawer vs what is.
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { backend } from '../../backend'
import { PageBody, PageHeader, Panel, SkeletonRows, TableScroll } from '../../components/admin'
import { Banner, Button, useToast } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { addDays, cafeDate, dateTime, formatDay, money, signedMoney } from '../../lib/format'
import type { DayCloseSummary, DayClosing } from '../../lib/types'

const rupees = (v: string) => (v.trim() === '' ? NaN : Number(v.replace(/[,\s₹]/g, '')))
const valid = (n: number) => Number.isInteger(n) && n >= 0 && n <= 10_000_000

export function DayClosePage() {
  const toast = useToast()
  const ids = useId()
  const today = cafeDate()
  const [day, setDay] = useState(today)
  const [summary, setSummary] = useState<DayCloseSummary | null>(null)
  const [history, setHistory] = useState<DayClosing[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [float, setFloat] = useState('')
  const [paidOut, setPaidOut] = useState('')
  const [counted, setCounted] = useState('')
  const [note, setNote] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setSummary(null)
    setError(null)
    try {
      const [s, h] = await Promise.all([backend.dayCloseSummary(day), backend.listDayClosings(addDays(today, -30), today)])
      setSummary(s)
      setHistory(h)
      const c = s.closing
      setFloat(String(c?.opening_float ?? s.last_float ?? ''))
      setPaidOut(c ? String(c.cash_paid_out) : '')
      setCounted(c ? String(c.counted_cash) : '')
      setNote(c?.note ?? '')
    } catch (e) {
      setError(friendlyError(e))
    }
  }, [day, today])

  useEffect(() => {
    void load()
  }, [load])

  const f = rupees(float)
  const p = rupees(paidOut === '' ? '0' : paidOut)
  const c = rupees(counted)
  const expected = summary && valid(f) && valid(p) ? f + summary.cash_received - p : null
  const diff = expected !== null && valid(c) ? c - expected : null

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!valid(f)) return setFormError('Enter the cash you started the day with (₹0 if none).')
    if (!valid(p)) return setFormError('Enter cash taken out of the drawer in whole rupees (₹0 if none).')
    if (!valid(c)) return setFormError('Count the cash in the drawer and enter the total.')
    setFormError(null)
    setBusy(true)
    try {
      await backend.closeDay({ day, opening_float: f, paid_out: p, counted: c, note: note.trim() || null })
      toast(summary?.closing ? 'Closing updated' : 'Day closed', 'success')
      void load()
    } catch (err) {
      setFormError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageBody>
      <PageHeader
        title="Close the day"
        subtitle="Count the cash drawer and check it against what the orders say. Takes a minute at closing time."
        actions={
          <div className="flex items-center gap-2">
            <label htmlFor={`${ids}-day`} className="text-sm font-semibold text-muted">Day</label>
            <input id={`${ids}-day`} type="date" max={today} min={addDays(today, -62)} className="field-input min-h-10 !py-1.5" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
          </div>
        }
      />
      {error && <Banner tone="danger" className="mb-4">{error}</Banner>}

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <Panel title={`${formatDay(day)}${day === today ? ' (today)' : ''}`} description="Money that came in, by when it was received">
          {!summary ? (
            <SkeletonRows rows={4} />
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-3">
                <Figure label="Cash received" value={money(summary.cash_received)} hint={`${summary.cash_orders} cash orders`} />
                <Figure label="UPI confirmed" value={money(summary.upi_received)} hint={`${summary.upi_orders} orders — match this with your UPI app`} />
                <Figure label="Expenses logged" value={money(summary.expenses)} hint={<Link className="underline" to="/staff/expenses">See expenses</Link>} />
                <Figure label="Still unpaid" value={money(summary.unpaid_total)} hint={`${summary.unpaid_orders} orders`} />
              </dl>
              {summary.open_orders > 0 && (
                <Banner tone="warning" className="mt-4">{summary.open_orders} order(s) from this day are still open. Finish or cancel them on the board before closing, or close now and recount later.</Banner>
              )}
              {summary.cash_refunds_due > 0 && (
                <Banner tone="warning" className="mt-3">{money(summary.cash_refunds_due)} of cash orders were cancelled after payment. If you handed the money back, include it under “Cash taken out”.</Banner>
              )}
            </>
          )}
        </Panel>

        <Panel title="Count the drawer">
          <form onSubmit={submit} noValidate className="space-y-4">
            <Money id={`${ids}-float`} label="Cash at the start of the day" hint="Change you kept in the drawer" value={float} onChange={setFloat} />
            <Money id={`${ids}-out`} label="Cash taken out" hint="Shopping paid from the drawer, refunds given" value={paidOut} onChange={setPaidOut} />
            <div className="rounded-xl bg-sunken px-3 py-2.5 text-sm">
              <div className="flex justify-between"><span>Should be in the drawer</span><strong className="tabular">{expected === null ? '—' : money(expected)}</strong></div>
              <p className="mt-0.5 text-xs text-muted">Start + cash received − taken out</p>
            </div>
            <Money id={`${ids}-counted`} label="Cash counted now" value={counted} onChange={setCounted} big />
            {diff !== null && (
              <p className={`rounded-xl px-3 py-2.5 text-center text-lg font-extrabold ${diff === 0 ? 'bg-ready-soft text-ready' : diff < 0 ? 'bg-danger-soft text-danger' : 'bg-brand-soft text-ink'}`} role="status">
                {diff === 0 ? 'Matches exactly' : diff < 0 ? `Short by ${money(-diff)}` : `Over by ${money(diff)}`}
              </p>
            )}
            <div>
              <label htmlFor={`${ids}-note`} className="label">Note <span className="font-normal text-muted">(optional)</span></label>
              <input id={`${ids}-note`} className="field-input" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. gave ₹20 extra change by mistake" />
            </div>
            {formError && <Banner tone="danger">{formError}</Banner>}
            <Button type="submit" className="w-full" loading={busy} disabled={!summary}>{summary?.closing ? 'Update closing' : 'Close the day'}</Button>
            {summary?.closing && (
              <p className="text-center text-xs text-muted">Closed by {summary.closing.closed_by_name} · {dateTime(summary.closing.closed_at)}</p>
            )}
          </form>
        </Panel>
      </div>

      <Panel title="Past closings" description="Last 30 days" className="mt-4" flush>
        {!history ? (
          <SkeletonRows rows={3} />
        ) : history.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">No closings yet.</p>
        ) : (
          <TableScroll label="Past closings">
            <table className="dt min-w-[640px]">
              <thead>
                <tr>
                  <th>Day</th>
                  <th className="num">Cash received</th>
                  <th className="num">Expected</th>
                  <th className="num">Counted</th>
                  <th className="num">Difference</th>
                  <th className="num">UPI</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.day}>
                    <td><button type="button" className="font-semibold underline-offset-4 hover:underline" onClick={() => setDay(h.day)}>{formatDay(h.day)}</button></td>
                    <td className="num">{money(h.cash_received)}</td>
                    <td className="num">{money(h.expected_cash)}</td>
                    <td className="num">{money(h.counted_cash)}</td>
                    <td className={`num font-bold ${h.difference < 0 ? 'text-danger' : h.difference > 0 ? 'text-ink' : 'text-ready'}`}>{h.difference === 0 ? '✓' : signedMoney(h.difference)}</td>
                    <td className="num">{money(h.upi_received)}</td>
                    <td className="max-w-56 truncate text-muted">{h.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>
    </PageBody>
  )
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line p-3">
      <dt className="text-xs font-semibold text-muted">{label}</dt>
      <dd className="tabular mt-0.5 text-xl font-extrabold">{value}</dd>
      {hint && <dd className="mt-0.5 text-xs text-subtle">{hint}</dd>}
    </div>
  )
}

function Money({ id, label, hint, value, onChange, big = false }: { id: string; label: string; hint?: string; value: string; onChange: (v: string) => void; big?: boolean }) {
  return (
    <div>
      <label htmlFor={id} className="label">{label}</label>
      <div className="relative">
        <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-bold text-muted">₹</span>
        <input
          id={id}
          className={`field-input tabular pl-7 ${big ? 'text-xl font-extrabold' : ''}`}
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, '').slice(0, 8))}
          placeholder="0"
        />
      </div>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  )
}
