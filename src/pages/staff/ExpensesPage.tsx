import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { backend } from '../../backend'
import { PageBody, PageHeader, Panel, PeriodPicker, SkeletonRows, TableScroll, periodLabel, usePeriod } from '../../components/admin'
import { IconEdit, IconPlus, IconSearch, IconTrash, IconWallet } from '../../components/icons'
import { Banner, Button, Dialog, EmptyState, useToast } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { cafeDate, formatDay, money } from '../../lib/format'
import { EXPENSE_CATEGORIES, expenseLabel } from '../../lib/pnl'
import type { Expense, ExpenseCategory, ExpenseInput } from '../../lib/types'

export function ExpensesPage() {
  const toast = useToast()
  const [period, setPeriod] = usePeriod('expenses', 'month')
  const [rows, setRows] = useState<Expense[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [category, setCategory] = useState<ExpenseCategory | 'all'>('all')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Expense | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Expense | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      setRows(await backend.listExpenses(period.from, period.to))
    } catch (e) {
      setError(friendlyError(e))
    }
  }, [period.from, period.to])

  useEffect(() => {
    setRows(null)
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (rows ?? []).filter(
      (r) => (category === 'all' || r.category === category) && (!q || (r.note ?? '').toLowerCase().includes(q) || expenseLabel(r.category).toLowerCase().includes(q)),
    )
  }, [rows, category, query])
  const total = filtered.reduce((s, r) => s + r.amount, 0)
  const byCategory = useMemo(() => {
    const m = new Map<ExpenseCategory, number>()
    for (const r of rows ?? []) m.set(r.category, (m.get(r.category) ?? 0) + r.amount)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [rows])
  const grand = byCategory.reduce((s, [, v]) => s + v, 0)

  async function confirmDelete() {
    if (!deleting) return
    setBusy(true)
    try {
      await backend.deleteExpense(deleting.id)
      toast('Expense deleted', 'success')
      setDeleting(null)
      void load()
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageBody>
      <PageHeader
        title="Expenses"
        subtitle="Money spent running the café. These feed into Profit & loss."
        actions={<Button size="sm" onClick={() => setEditing('new')}><IconPlus size={16} /> Add expense</Button>}
      >
        <PeriodPicker value={period} onChange={setPeriod} maxDays={366} />
      </PageHeader>

      {error && <Banner tone="danger" className="mb-4" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}>{error}</Banner>}

      {!rows ? (
        !error && <div className="card"><SkeletonRows rows={6} label="Loading expenses" /></div>
      ) : rows.length === 0 ? (
        <div className="card">
          <EmptyState icon={<IconWallet size={28} />} title={`No expenses in ${periodLabel(period).toLowerCase()}`}>
            Log what you spend — milk, gas, wages, rent — to see your real profit.
          </EmptyState>
          <div className="-mt-6 pb-10 text-center"><Button onClick={() => setEditing('new')}><IconPlus size={16} /> Log your first expense</Button></div>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <Panel flush>
            <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
              <div className="relative min-w-0 flex-1 basis-48">
                <IconSearch size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle" />
                <input
                  type="search"
                  className="field-input !min-h-10 !rounded-md !py-1.5 !pl-9 text-sm"
                  placeholder="Search notes"
                  aria-label="Search expenses"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <select
                aria-label="Filter by category"
                className="field-input !min-h-10 !w-auto !rounded-md !py-1.5 text-sm"
                value={category}
                onChange={(e) => setCategory(e.target.value as ExpenseCategory | 'all')}
              >
                <option value="all">All categories</option>
                {EXPENSE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
              {(category !== 'all' || query) && (
                <button type="button" className="text-sm font-semibold underline" onClick={() => { setCategory('all'); setQuery('') }}>Clear</button>
              )}
            </div>
            {filtered.length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-muted">No expenses match these filters.</p>
            ) : (
              <>
                <div className="hidden md:block">
                  <TableScroll label="Expenses">
                    <table className="dt">
                      <thead>
                        <tr>
                          <th scope="col">Date</th>
                          <th scope="col">Category</th>
                          <th scope="col">Note</th>
                          <th scope="col" className="num">Amount</th>
                          <th scope="col"><span className="sr-only">Actions</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((r) => (
                          <tr key={r.id}>
                            <td className="whitespace-nowrap">{formatDay(r.spent_on)}</td>
                            <td className="whitespace-nowrap font-semibold">{expenseLabel(r.category)}</td>
                            <td className="max-w-[280px] truncate text-muted">{r.note ?? '—'}</td>
                            <td className="num font-bold">{money(r.amount)}</td>
                            <td><RowButtons row={r} onEdit={setEditing} onDelete={setDeleting} /></td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan={3}>Total{filtered.length !== rows.length ? ' (filtered)' : ''} · {filtered.length} {filtered.length === 1 ? 'entry' : 'entries'}</td>
                          <td className="num">{money(total)}</td>
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                  </TableScroll>
                </div>
                <ul className="divide-y divide-line md:hidden">
                  {filtered.map((r) => (
                    <li key={r.id} className="flex items-start gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold">{expenseLabel(r.category)}</p>
                        <p className="truncate text-sm text-muted">{formatDay(r.spent_on)}{r.note ? ` · ${r.note}` : ''}</p>
                      </div>
                      <div className="text-right">
                        <p className="tabular font-bold">{money(r.amount)}</p>
                        <RowButtons row={r} onEdit={setEditing} onDelete={setDeleting} />
                      </div>
                    </li>
                  ))}
                  <li className="flex justify-between px-4 py-3 font-bold"><span>Total</span><span className="tabular">{money(total)}</span></li>
                </ul>
              </>
            )}
          </Panel>

          <Panel title="By category" description={periodLabel(period)}>
            <ul className="space-y-3">
              {byCategory.map(([c, amount]) => (
                <li key={c}>
                  <button type="button" className="w-full text-left" onClick={() => setCategory(category === c ? 'all' : c)} aria-pressed={category === c}>
                    <span className="flex justify-between gap-2 text-sm">
                      <span className={category === c ? 'font-bold' : 'font-semibold'}>{expenseLabel(c)}</span>
                      <span className="tabular font-bold">{money(amount)}</span>
                    </span>
                    <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-sunken">
                      <span className="block h-full rounded-full bg-ink" style={{ width: `${grand ? Math.max(2, (amount / grand) * 100) : 0}%` }} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-4 flex justify-between border-t border-line pt-3 text-sm font-bold">
              <span>Total</span>
              <span className="tabular">{money(grand)}</span>
            </p>
          </Panel>
        </div>
      )}

      {editing && (
        <ExpenseDrawer
          expense={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(again) => {
            void load()
            if (!again) setEditing(null)
          }}
        />
      )}

      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete this expense?"
        size="sm"
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setDeleting(null)}>Keep it</Button>
            <Button variant="danger" className="flex-1" loading={busy} onClick={() => void confirmDelete()}>Delete {deleting ? money(deleting.amount) : ''}</Button>
          </div>
        }
      >
        {deleting && (
          <p className="p-5 text-sm">
            {expenseLabel(deleting.category)} on {formatDay(deleting.spent_on)}{deleting.note ? ` (“${deleting.note}”)` : ''}. Profit & loss will update. The audit log keeps a record.
          </p>
        )}
      </Dialog>
    </PageBody>
  )
}

function RowButtons({ row, onEdit, onDelete }: { row: Expense; onEdit: (r: Expense) => void; onDelete: (r: Expense) => void }) {
  const label = `${expenseLabel(row.category)} ${money(row.amount)} on ${formatDay(row.spent_on)}`
  return (
    <div className="flex justify-end gap-1">
      <Button size="sm" variant="ghost" onClick={() => onEdit(row)} aria-label={`Edit ${label}`} title="Edit"><IconEdit size={16} /></Button>
      <Button size="sm" variant="ghost" onClick={() => onDelete(row)} aria-label={`Delete ${label}`} title="Delete"><IconTrash size={16} /></Button>
    </div>
  )
}

function ExpenseDrawer({ expense, onClose, onSaved }: { expense: Expense | null; onClose: () => void; onSaved: (addAnother: boolean) => void }) {
  const toast = useToast()
  const ids = { date: useId(), cat: useId(), amount: useId(), note: useId() }
  const blank = (): ExpenseInput => ({ spent_on: cafeDate(), category: 'ingredients', amount: 0, note: '' })
  const [form, setForm] = useState<ExpenseInput>(() => (expense ? { spent_on: expense.spent_on, category: expense.category, amount: expense.amount, note: expense.note ?? '' } : blank()))
  const [amountText, setAmountText] = useState(expense ? String(expense.amount) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hint = EXPENSE_CATEGORIES.find((c) => c.value === form.category)?.hint

  async function save(addAnother: boolean) {
    const amount = Number(amountText)
    if (!Number.isInteger(amount) || amount < 1) return setError('Enter the amount in whole rupees.')
    if (!form.spent_on || form.spent_on > cafeDate()) return setError('Choose a date that isn’t in the future.')
    setBusy(true)
    setError(null)
    const input = { ...form, amount, note: form.note?.trim() || null }
    try {
      if (expense) await backend.updateExpense(expense.id, input)
      else await backend.addExpense(input)
      toast(`${expenseLabel(input.category)} · ${money(amount)} saved`, 'success')
      onSaved(addAnother)
      if (addAnother) {
        setForm({ ...blank(), spent_on: form.spent_on, category: form.category })
        setAmountText('')
      }
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      drawer
      onClose={onClose}
      title={expense ? 'Edit expense' : 'Add expense'}
      footer={
        <div className="flex flex-wrap gap-2">
          {!expense && <Button variant="secondary" className="flex-1" onClick={() => void save(true)} disabled={busy}>Save & add another</Button>}
          <Button className="flex-1" loading={busy} onClick={() => void save(false)}>Save</Button>
        </div>
      }
    >
      <div className="space-y-5 p-5">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={ids.date} className="label">Date</label>
            <input id={ids.date} type="date" max={cafeDate()} className="field-input" value={form.spent_on} onChange={(e) => setForm({ ...form, spent_on: e.target.value })} />
          </div>
          <div>
            <label htmlFor={ids.amount} className="label">Amount (₹)</label>
            <input id={ids.amount} inputMode="numeric" className="field-input tabular" value={amountText} onChange={(e) => setAmountText(e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="0" />
          </div>
        </div>
        <div>
          <label htmlFor={ids.cat} className="label">Category</label>
          <select id={ids.cat} className="field-input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as ExpenseCategory })}>
            {EXPENSE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
        </div>
        <div>
          <label htmlFor={ids.note} className="label">Note (optional)</label>
          <input id={ids.note} className="field-input" maxLength={140} value={form.note ?? ''} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="e.g. 20 L milk from Nandini" />
        </div>
        {form.category === 'ingredients' && (
          <Banner tone="info">Ingredient purchases are compared with your item costs in Profit & loss, not subtracted twice.</Banner>
        )}
        {error && <Banner tone="danger">{error}</Banner>}
      </div>
    </Dialog>
  )
}
