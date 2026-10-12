import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { backend } from '../../backend'
import { Panel, SkeletonRows, StockBadge, TableScroll } from '../../components/admin'
import { IconBox, IconEdit, IconHistory, IconPlus, IconSearch } from '../../components/icons'
import { Banner, Button, Dialog, EmptyState, useToast } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { ago, dateTime, money } from '../../lib/format'
import type { Ingredient, IngredientAdjustKind, IngredientMovement, Recipes } from '../../lib/types'
import { baseOf, formatQty, formatUnitCost, fromBase, INGREDIENT_SUGGESTIONS, toBase, UNITS, unitsFor, type Unit } from '../../lib/units'
import { usePublicData } from '../../state/publicData'

type Filter = 'all' | 'low' | 'out'

const KINDS: { kind: IngredientAdjustKind; label: string; help: string }[] = [
  { kind: 'purchase', label: 'Bought', help: 'Stock you bought or received.' },
  { kind: 'usage', label: 'Used', help: 'Used in cooking (not counted by a recipe).' },
  { kind: 'waste', label: 'Wasted', help: 'Spoiled, spilled or thrown away.' },
  { kind: 'count', label: 'Counted', help: 'What’s actually on the shelf now.' },
]

const MOVE_LABEL: Record<IngredientMovement['kind'], string> = {
  opening: 'Added', purchase: 'Bought', usage: 'Used', sale: 'Used for an order', cancel_return: 'Returned (order cancelled)',
  waste: 'Wasted', count: 'Counted', correction: 'Correction',
}

/** Free-typed quantity (decimals allowed) → number, or NaN. */
const parseQty = (text: string) => (text.trim() === '' ? NaN : Number(text.replace(',', '.')))

export function IngredientsPanel() {
  const { data } = usePublicData()
  const [rows, setRows] = useState<Ingredient[] | null>(null)
  const [recipes, setRecipes] = useState<Recipes>({})
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Ingredient | 'new' | null>(null)
  const [recording, setRecording] = useState<Ingredient | null>(null)
  const [history, setHistory] = useState<Ingredient | null>(null)

  const load = useCallback(async () => {
    try {
      const [list, rec] = await Promise.all([backend.listIngredients(), backend.getRecipes()])
      setRows(list)
      setRecipes(rec)
      setError(null)
    } catch (e) {
      setError(friendlyError(e))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const status = (i: Ingredient) => (i.on_hand <= 0 ? 'out' : i.on_hand <= i.low_at ? 'low' : 'ok')
  const all = useMemo(
    () => [...(rows ?? [])].sort((a, b) => rankOf(status(a)) - rankOf(status(b)) || a.name.localeCompare(b.name)),
    [rows],
  )
  const q = query.trim().toLowerCase()
  const shown = all.filter((i) => (filter === 'all' || status(i) === filter) && (!q || i.name.toLowerCase().includes(q)))
  const lowCount = all.filter((i) => status(i) === 'low').length
  const outCount = all.filter((i) => status(i) === 'out').length
  const value = all.reduce((s, i) => s + (i.on_hand > 0 && i.cost_per_unit !== null ? i.on_hand * i.cost_per_unit : 0), 0)

  /** Which menu items use this ingredient, e.g. "Masala Chai (100 ml)". */
  const usedIn = (ing: Ingredient) =>
    Object.entries(recipes)
      .flatMap(([itemId, lines]) => {
        const line = lines.find((l) => l.ingredient_id === ing.id)
        const item = data?.menu.items.find((m) => m.id === itemId)
        return line && item ? [`${item.name} (${formatQty(line.quantity, ing.base_unit)})`] : []
      })
      .sort()

  return (
    <>
      {error && <Banner tone="danger" className="mb-4" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}>{error}</Banner>}

      {!rows ? (
        !error && <div className="card"><SkeletonRows label="Loading raw materials" /></div>
      ) : rows.length === 0 ? (
        <div className="card">
          <EmptyState icon={<IconBox size={28} />} title="No raw materials yet">
            Add what you cook with — milk, maida, tea powder, oil — with the unit you buy it in. Then record what you buy and use.
          </EmptyState>
          <div className="-mt-6 pb-10 text-center"><Button onClick={() => setEditing('new')}><IconPlus size={16} /> Add ingredient</Button></div>
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 basis-44">
              <IconSearch size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle" />
              <input type="search" aria-label="Search raw materials" placeholder="Search raw materials" className="field-input !min-h-10 !rounded-md !py-1.5 !pl-9 text-sm" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="flex gap-1.5" role="group" aria-label="Filter raw materials">
              {([['all', `All ${all.length}`], ['low', `Low ${lowCount}`], ['out', `Out ${outCount}`]] as [Filter, string][]).map(([f, label]) => (
                <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}
                  className={`min-h-9 rounded-full border px-3.5 text-sm font-semibold ${filter === f ? 'border-ink bg-ink text-white' : 'border-line-strong bg-surface hover:border-ink'}`}>
                  {label}
                </button>
              ))}
            </div>
            <Button size="sm" onClick={() => setEditing('new')}><IconPlus size={16} /> Add ingredient</Button>
          </div>
          <p className="mb-3 text-sm text-muted">
            Stock value at last purchase price: <span className="tabular font-bold text-ink">{money(Math.round(value))}</span>
            {lowCount + outCount > 0 && <> · <span className="font-semibold text-[#8a4b00]">{lowCount + outCount} to restock</span></>}
          </p>

          <Panel flush>
            {shown.length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-muted">Nothing matches. <button type="button" className="font-semibold underline" onClick={() => { setFilter('all'); setQuery('') }}>Show all</button></p>
            ) : (
              <>
                <div className="hidden md:block">
                  <TableScroll label="Raw materials">
                    <table className="dt">
                      <thead>
                        <tr>
                          <th scope="col">Raw material</th>
                          <th scope="col" className="num">In stock</th>
                          <th scope="col" className="num">Warn at</th>
                          <th scope="col" className="num">Price</th>
                          <th scope="col">Status</th>
                          <th scope="col">Updated</th>
                          <th scope="col"><span className="sr-only">Actions</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((i) => (
                          <tr key={i.id}>
                            <td className="font-semibold">{i.name}</td>
                            <td className={`num text-base font-extrabold ${i.on_hand < 0 ? 'text-danger' : ''}`}>{formatQty(i.on_hand, i.display_unit)}</td>
                            <td className="num text-muted">{formatQty(i.low_at, i.display_unit)}</td>
                            <td className="num text-muted">{formatUnitCost(i.cost_per_unit, i.display_unit) ?? '—'}</td>
                            <td><StockBadge onHand={i.on_hand} lowAt={i.low_at} /></td>
                            <td className="whitespace-nowrap text-muted" title={dateTime(i.updated_at)}>{ago(i.updated_at)}</td>
                            <td><Actions ing={i} onRecord={setRecording} onHistory={setHistory} onEdit={setEditing} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableScroll>
                </div>
                <ul className="divide-y divide-line md:hidden">
                  {shown.map((i) => (
                    <li key={i.id} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-semibold">{i.name}</p>
                          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
                            <StockBadge onHand={i.on_hand} lowAt={i.low_at} /> Warn at {formatQty(i.low_at, i.display_unit)}
                            {formatUnitCost(i.cost_per_unit, i.display_unit) && <> · {formatUnitCost(i.cost_per_unit, i.display_unit)}</>}
                          </p>
                        </div>
                        <p className={`tabular shrink-0 text-lg font-extrabold ${i.on_hand < 0 ? 'text-danger' : ''}`}>{formatQty(i.on_hand, i.display_unit)}</p>
                      </div>
                      <div className="mt-2"><Actions ing={i} onRecord={setRecording} onHistory={setHistory} onEdit={setEditing} /></div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Panel>
          {all.some((i) => i.on_hand < 0) && (
            <Banner tone="warning" className="mt-3">
              Some stock shows below zero: orders used more than was recorded. Count those items and record it with <strong>Counted</strong>.
            </Banner>
          )}
        </>
      )}

      {editing && (
        <IngredientDrawer
          ingredient={editing === 'new' ? null : editing}
          usedIn={editing === 'new' ? [] : usedIn(editing)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void load()
          }}
        />
      )}
      {recording && (
        <RecordDrawer
          ingredient={recording}
          onClose={() => setRecording(null)}
          onSaved={() => {
            setRecording(null)
            void load()
          }}
        />
      )}
      {history && <HistoryDrawer ingredient={history} onClose={() => setHistory(null)} />}
    </>
  )
}

const rankOf = (s: string) => (s === 'out' ? 0 : s === 'low' ? 1 : 2)

function Actions({ ing, onRecord, onHistory, onEdit }: { ing: Ingredient; onRecord: (i: Ingredient) => void; onHistory: (i: Ingredient) => void; onEdit: (i: Ingredient) => void }) {
  return (
    <div className="flex items-center justify-end gap-1">
      <Button size="sm" variant="secondary" onClick={() => onRecord(ing)} aria-label={`Record stock for ${ing.name}`}>Record</Button>
      <Button size="sm" variant="ghost" onClick={() => onHistory(ing)} aria-label={`History for ${ing.name}`} title="History"><IconHistory size={16} /></Button>
      <Button size="sm" variant="ghost" onClick={() => onEdit(ing)} aria-label={`Edit ${ing.name}`} title="Edit"><IconEdit size={16} /></Button>
    </div>
  )
}

/** Number field + unit dropdown limited to units that measure the same thing. */
function QtyField({ id, label, value, onChange, unit, onUnit, units, hint, allowNegative = false }: {
  id: string; label: string; value: string; onChange: (v: string) => void; unit: Unit; onUnit: (u: Unit) => void; units: { value: Unit; label: string }[]; hint?: string; allowNegative?: boolean
}) {
  return (
    <div>
      <label htmlFor={id} className="label">{label}</label>
      <div className="flex gap-2">
        <input
          id={id}
          className="field-input tabular min-w-0 flex-1"
          inputMode="decimal"
          placeholder="0"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(allowNegative ? /[^\d.,-]/g : /[^\d.,]/g, '').slice(0, 12))}
        />
        <select aria-label={`${label} unit`} className="field-input !w-auto" value={unit} onChange={(e) => onUnit(e.target.value as Unit)}>
          {units.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
        </select>
      </div>
      {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
    </div>
  )
}

function IngredientDrawer({ ingredient, usedIn, onClose, onSaved }: { ingredient: Ingredient | null; usedIn: string[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const ids = { name: useId(), opening: useId(), low: useId(), list: useId() }
  const isNew = !ingredient
  const [name, setName] = useState(ingredient?.name ?? '')
  const [unit, setUnit] = useState<Unit>(ingredient?.display_unit ?? 'kg')
  const [unitTouched, setUnitTouched] = useState(!isNew)
  const [opening, setOpening] = useState('')
  const [openingUnit, setOpeningUnit] = useState<Unit>(ingredient?.display_unit ?? 'kg')
  const [low, setLow] = useState(ingredient ? String(fromBase(ingredient.low_at, ingredient.display_unit)) : '')
  const [lowUnit, setLowUnit] = useState<Unit>(ingredient?.display_unit ?? 'kg')
  const [busy, setBusy] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const base = baseOf(unit)
  const family = unitsFor(base)

  function chooseUnit(u: Unit) {
    setUnit(u)
    setUnitTouched(true)
    setOpeningUnit(u)
    setLowUnit(u)
  }

  function onName(v: string) {
    setName(v)
    // Picking a suggestion also picks its usual unit, unless a unit was chosen already.
    const hit = INGREDIENT_SUGGESTIONS.find((s) => s.name.toLowerCase() === v.trim().toLowerCase())
    if (hit && isNew && !unitTouched) {
      setUnit(hit.unit)
      setOpeningUnit(hit.unit)
      setLowUnit(hit.unit)
    }
  }

  async function save() {
    const o = opening.trim() === '' ? 0 : parseQty(opening)
    const l = low.trim() === '' ? 0 : parseQty(low)
    if (!name.trim()) return setError('Enter a name, for example “Milk”.')
    if (!(o >= 0) || !(l >= 0)) return setError('Quantities must be numbers of 0 or more.')
    setBusy(true)
    setError(null)
    try {
      await backend.saveIngredient({
        id: ingredient?.id, name: name.trim(), base_unit: base, display_unit: unit,
        low_at: toBase(l, lowUnit), ...(isNew ? { opening: toBase(o, openingUnit) } : {}),
      })
      toast(isNew ? `${name.trim()} added` : `${name.trim()} updated`, 'success')
      onSaved()
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  async function archive() {
    if (!ingredient) return
    setBusy(true)
    try {
      await backend.archiveIngredient(ingredient.id)
      toast(`${ingredient.name} removed`, 'success')
      onSaved()
    } catch (e) {
      setError(friendlyError(e))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      drawer
      onClose={onClose}
      title={isNew ? 'Add raw material' : `Edit ${ingredient.name}`}
      footer={
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button className="flex-[2]" loading={busy} onClick={() => void save()}>{isNew ? 'Add raw material' : 'Save'}</Button>
        </div>
      }
    >
      <div className="space-y-5 p-5">
        <div>
          <label htmlFor={ids.name} className="label">Name</label>
          <input id={ids.name} className="field-input" list={ids.list} maxLength={60} autoComplete="off" value={name} onChange={(e) => onName(e.target.value)} placeholder="Type any name — e.g. Milk, Maida, Tea powder" />
          <datalist id={ids.list}>
            {INGREDIENT_SUGGESTIONS.map((s) => <option key={s.name} value={s.name} />)}
          </datalist>
          <p className="mt-1.5 text-xs text-muted">Type anything. Suggestions appear as you type.</p>
        </div>
        <div>
          <label htmlFor={`${ids.name}-unit`} className="label">Measured in</label>
          <select id={`${ids.name}-unit`} className="field-input" value={unit} onChange={(e) => chooseUnit(e.target.value as Unit)}>
            {(isNew ? UNITS : family).map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
          </select>
          <p className="mt-1.5 text-xs text-muted">
            {isNew ? 'The unit you usually buy it in. You can still enter g with kg, or ml with litres.' : 'Weight, volume and pieces can’t be swapped once an ingredient has history.'}
          </p>
        </div>
        {isNew && (
          <QtyField id={ids.opening} label="In stock right now" value={opening} onChange={setOpening} unit={openingUnit} onUnit={setOpeningUnit} units={family} hint="Leave empty if you’ll record a purchase next." />
        )}
        <QtyField id={ids.low} label="Warn me when it drops to" value={low} onChange={setLow} unit={lowUnit} onUnit={setLowUnit} units={family} />
        {usedIn.length > 0 && (
          <Banner tone="info" title="Used in recipes">{usedIn.join(', ')}</Banner>
        )}
        {error && <Banner tone="danger">{error}</Banner>}
        {!isNew && (
          <div className="border-t border-line pt-5">
            {confirmArchive ? (
              <div className="space-y-3">
                <p className="text-sm">Remove {ingredient.name}? It’s taken out of recipes. Its history stays in reports and the audit log.</p>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => setConfirmArchive(false)}>Keep it</Button>
                  <Button variant="danger" loading={busy} onClick={() => void archive()}>Remove {ingredient.name}</Button>
                </div>
              </div>
            ) : (
              <Button variant="danger" size="sm" onClick={() => setConfirmArchive(true)}>Remove raw material</Button>
            )}
          </div>
        )}
      </div>
    </Dialog>
  )
}

function RecordDrawer({ ingredient, onClose, onSaved }: { ingredient: Ingredient; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const ids = { qty: useId(), price: useId(), note: useId() }
  const family = unitsFor(ingredient.base_unit)
  const [kind, setKind] = useState<IngredientAdjustKind>('purchase')
  const [qty, setQty] = useState('')
  const [unit, setUnit] = useState<Unit>(ingredient.display_unit)
  const [price, setPrice] = useState('')
  const [addExpense, setAddExpense] = useState(true)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const n = parseQty(qty)
  const base = Number.isFinite(n) ? toBase(n, unit) : NaN
  const valid = Number.isFinite(base) && (kind === 'count' ? base >= 0 : base > 0)
  const after = !valid ? null : kind === 'purchase' ? ingredient.on_hand + base : kind === 'count' ? base : ingredient.on_hand - base
  const amount = price.trim() === '' ? null : Number(price)
  const perUnit = kind === 'purchase' && valid && amount ? formatUnitCost(amount / base, ingredient.display_unit) : null
  const wasteValue = kind === 'waste' && valid && ingredient.cost_per_unit !== null ? Math.round(base * ingredient.cost_per_unit) : null
  const verb = { purchase: 'Save purchase', usage: 'Save usage', waste: 'Save waste', count: 'Save count', correction: 'Save' }[kind]

  async function save() {
    if (!valid) return setError(kind === 'count' ? 'Enter how much is on the shelf (0 or more).' : 'Enter a quantity above zero.')
    if (amount !== null && !(Number.isInteger(amount) && amount >= 0)) return setError('Enter the price in whole rupees.')
    setBusy(true)
    setError(null)
    try {
      const label = `${n} ${unit}`
      const res = await backend.adjustIngredient(ingredient.id, kind, base, {
        amount: kind === 'purchase' ? amount : null, note: note.trim() || null, addExpense: kind === 'purchase' && addExpense, label,
      })
      toast(`${ingredient.name}: ${formatQty(res.on_hand, res.display_unit)} in stock`, 'success')
      onSaved()
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
      title={`Record ${ingredient.name}`}
      description={`${formatQty(ingredient.on_hand, ingredient.display_unit)} in stock now`}
      footer={
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button className="flex-[2]" loading={busy} onClick={() => void save()}>{verb}</Button>
        </div>
      }
    >
      <div className="space-y-5 p-5">
        <fieldset>
          <legend className="label">What happened?</legend>
          <div className="grid grid-cols-2 gap-2">
            {KINDS.map((k) => (
              <label key={k.kind} className={`cursor-pointer rounded-lg border p-3 ${kind === k.kind ? 'border-ink bg-sunken ring-1 ring-ink' : 'border-line-strong hover:border-ink'}`}>
                <input type="radio" name="record-kind" value={k.kind} checked={kind === k.kind} onChange={() => setKind(k.kind)} className="sr-only" />
                <span className="block text-sm font-bold">{k.label}</span>
                <span className="mt-0.5 block text-xs text-muted">{k.help}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <QtyField
          id={ids.qty}
          label={kind === 'count' ? 'On the shelf now' : kind === 'purchase' ? 'Quantity bought' : kind === 'waste' ? 'Quantity wasted' : 'Quantity used'}
          value={qty}
          onChange={setQty}
          unit={unit}
          onUnit={setUnit}
          units={family}
        />
        <p className="-mt-2 text-sm text-muted" aria-live="polite">
          {after === null ? 'The new stock level will show here.' : (
            <>Stock: <span className="tabular font-bold text-ink">{formatQty(ingredient.on_hand, ingredient.display_unit)}</span> → <span className={`tabular font-bold ${after < 0 ? 'text-danger' : 'text-ink'}`}>{formatQty(after, ingredient.display_unit)}</span></>
          )}
        </p>
        {kind === 'purchase' && (
          <div className="space-y-3 rounded-xl border border-line bg-sunken p-3">
            <div>
              <label htmlFor={ids.price} className="label">Price paid (₹, total) <span className="font-normal text-muted">· optional</span></label>
              <input id={ids.price} className="field-input tabular" inputMode="numeric" placeholder="e.g. 300" value={price} onChange={(e) => setPrice(e.target.value.replace(/\D/g, '').slice(0, 8))} />
              {perUnit && <p className="mt-1.5 text-xs text-muted">Works out to {perUnit}.</p>}
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 size-4 accent-ink" checked={addExpense} onChange={(e) => setAddExpense(e.target.checked)} />
              <span>Also add {amount ? money(amount) : 'this'} to Expenses (Ingredients & groceries), dated today</span>
            </label>
          </div>
        )}
        {wasteValue !== null && <p className="-mt-2 text-sm text-muted">Worth about <span className="font-bold text-ink">{money(wasteValue)}</span> at your last purchase price. It counts as waste in Profit & loss.</p>}
        <div>
          <label htmlFor={ids.note} className="label">Note <span className="font-normal text-muted">· optional</span></label>
          <input id={ids.note} className="field-input" maxLength={140} value={note} onChange={(e) => setNote(e.target.value)} placeholder={kind === 'purchase' ? 'e.g. from Nandini dairy' : kind === 'waste' ? 'e.g. milk spoiled' : ''} />
        </div>
        {error && <Banner tone="danger">{error}</Banner>}
      </div>
    </Dialog>
  )
}

function HistoryDrawer({ ingredient, onClose }: { ingredient: Ingredient; onClose: () => void }) {
  const [rows, setRows] = useState<IngredientMovement[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    backend.listIngredientMovements(ingredient.id, 300).then(setRows, (e) => setError(friendlyError(e)))
  }, [ingredient.id])
  return (
    <Dialog open drawer onClose={onClose} title={`${ingredient.name} history`} description="Every change, newest first.">
      {error ? (
        <div className="p-5"><Banner tone="danger">{error}</Banner></div>
      ) : !rows ? (
        <SkeletonRows label="Loading history" />
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((m) => (
            <li key={m.id} className="flex items-start gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{MOVE_LABEL[m.kind]}{m.amount ? ` · ${money(m.amount)}` : ''}</p>
                <p className="text-xs text-muted">{dateTime(m.created_at)}{m.actor_name && ` · ${m.actor_name}`}</p>
                {m.note && <p className="mt-0.5 text-sm text-ink-2">“{m.note}”</p>}
              </div>
              <div className="text-right">
                <p className={`tabular text-sm font-bold ${m.delta < 0 ? 'text-danger' : m.delta > 0 ? 'text-ready' : 'text-muted'}`}>
                  {m.delta > 0 ? '+' : ''}{formatQty(m.delta, ingredient.display_unit)}
                </p>
                <p className="tabular text-xs text-muted">= {formatQty(m.on_hand_after, ingredient.display_unit)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
