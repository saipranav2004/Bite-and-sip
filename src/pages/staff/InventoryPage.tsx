import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { backend } from '../../backend'
import { PageBody, PageHeader, Panel, SkeletonRows, StockBadge, TableScroll } from '../../components/admin'
import { IconBox, IconHistory, IconPlus, IconSettings } from '../../components/icons'
import { Banner, Button, Dialog, EmptyState, useToast } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { ago, dateTime, money } from '../../lib/format'
import type { MenuItem, StockAdjustKind, StockLevel, StockMovement } from '../../lib/types'
import { usePublicData } from '../../state/publicData'
import { useStaffSession } from '../../state/staffSession'

type Filter = 'all' | 'low' | 'out'

const ADJUST: { kind: StockAdjustKind; label: string; help: string }[] = [
  { kind: 'restock', label: 'Received', help: 'Add a fresh batch or a delivery.' },
  { kind: 'waste', label: 'Waste', help: 'Remove items that were thrown away.' },
  { kind: 'count', label: 'Recount', help: 'Enter what is actually on the shelf.' },
  { kind: 'correction', label: 'Correction', help: 'Fix a mistake, up or down, with a note.' },
]

export const MOVEMENT_LABEL: Record<StockMovement['kind'], string> = {
  initial: 'Tracking started',
  sale: 'Sold',
  cancel_return: 'Returned (order cancelled)',
  restock: 'Received',
  waste: 'Waste',
  count: 'Recount',
  correction: 'Correction',
}

const WASTE_REASONS = ['Unsold at closing', 'Dropped or damaged', 'Expired', 'Made wrong']

export function InventoryPage() {
  const { profile } = useStaffSession()
  const owner = profile?.role === 'owner'
  const { data, refresh: refreshPublic } = usePublicData()
  const [stock, setStock] = useState<StockLevel[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [adjusting, setAdjusting] = useState<MenuItem | null>(null)
  const [history, setHistory] = useState<MenuItem | null>(null)
  const [configuring, setConfiguring] = useState<MenuItem | 'new' | null>(null)
  const [waste, setWaste] = useState<{ cost: number; units: number; uncosted: number } | null>(null)

  const load = useCallback(async () => {
    try {
      setStock(await backend.getStock())
      setError(null)
    } catch (e) {
      setError(friendlyError(e))
    }
    if (owner) {
      try {
        const moves = await backend.listStockMovements(null, 1000)
        const since = new Date(Date.now() - 7 * 86400000).toISOString()
        const w = moves.filter((m) => m.kind === 'waste' && m.created_at >= since)
        setWaste({
          cost: w.reduce((s, m) => s + (m.unit_cost === null ? 0 : -m.delta * m.unit_cost), 0),
          units: w.reduce((s, m) => s - m.delta, 0),
          uncosted: w.filter((m) => m.unit_cost === null).length,
        })
      } catch {
        setWaste(null)
      }
    }
  }, [owner])

  useEffect(() => {
    void load()
  }, [load])

  const changed = useCallback(() => {
    void load()
    void refreshPublic()
  }, [load, refreshPublic])

  const items = data?.menu.items ?? []
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const tracked = useMemo(
    () =>
      (stock ?? [])
        .filter((s) => byId.has(s.menu_item_id))
        .map((s) => ({ level: s, item: byId.get(s.menu_item_id)! }))
        // Out first, then low, then by name: what needs attention comes first.
        .sort((a, b) => rank(a.level) - rank(b.level) || a.item.name.localeCompare(b.item.name)),
    [stock, byId],
  )
  const untracked = items.filter((i) => !(stock ?? []).some((s) => s.menu_item_id === i.id))
  const lowCount = tracked.filter((t) => t.level.on_hand > 0 && t.level.on_hand <= t.level.low_at).length
  const outCount = tracked.filter((t) => t.level.on_hand <= 0).length
  const shown = tracked.filter((t) => (filter === 'out' ? t.level.on_hand <= 0 : filter === 'low' ? t.level.on_hand > 0 && t.level.on_hand <= t.level.low_at : true))

  return (
    <PageBody>
      <PageHeader
        title="Inventory"
        subtitle="Count items you make in batches, like samosas or sandwiches. Tracked items sell out by themselves at zero."
        actions={
          owner && untracked.length > 0 ? (
            <Button size="sm" onClick={() => setConfiguring('new')}>
              <IconPlus size={16} /> Track an item
            </Button>
          ) : undefined
        }
      />

      {error && <Banner tone="danger" className="mb-4" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}>{error}</Banner>}

      {!stock || !data ? (
        <div className="card"><SkeletonRows label="Loading stock" /></div>
      ) : tracked.length === 0 ? (
        <div className="card">
          <EmptyState icon={<IconBox size={28} />} title="No items tracked yet">
            {owner ? 'Track the items you prepare in batches. Each order then reduces the count, and the item sells out by itself at zero.' : 'The owner hasn’t turned on stock tracking for any item yet.'}
          </EmptyState>
          {owner && <div className="-mt-6 pb-10 text-center"><Button onClick={() => setConfiguring('new')}><IconPlus size={16} /> Track an item</Button></div>}
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Filter stock">
            {([
              ['all', `All ${tracked.length}`],
              ['low', `Low ${lowCount}`],
              ['out', `Out ${outCount}`],
            ] as [Filter, string][]).map(([f, label]) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={`min-h-9 rounded-full border px-3.5 text-sm font-semibold ${filter === f ? 'border-ink bg-ink text-white' : 'border-line-strong bg-surface hover:border-ink'}`}
              >
                {label}
              </button>
            ))}
            {owner && waste && (
              <p className="ml-auto text-sm text-muted">
                Waste, last 7 days: <span className="tabular font-bold text-ink">{money(waste.cost)}</span> · {waste.units} items
                {waste.uncosted > 0 && <span> (some without a cost)</span>}
              </p>
            )}
          </div>

          <Panel flush>
            {shown.length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-muted">
                Nothing {filter === 'out' ? 'out of stock' : 'running low'}. <button type="button" className="font-semibold underline" onClick={() => setFilter('all')}>Show all</button>
              </p>
            ) : (
              <>
                <div className="hidden md:block">
                  <TableScroll label="Stock levels">
                    <table className="dt">
                      <thead>
                        <tr>
                          <th scope="col">Item</th>
                          <th scope="col" className="num">On hand</th>
                          <th scope="col" className="num">Low at</th>
                          <th scope="col">Status</th>
                          <th scope="col">Updated</th>
                          <th scope="col"><span className="sr-only">Actions</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map(({ level, item }) => (
                          <tr key={item.id}>
                            <td className="font-semibold">{item.name}</td>
                            <td className="num text-base font-extrabold">{level.on_hand}</td>
                            <td className="num text-muted">{level.low_at}</td>
                            <td><StockBadge onHand={level.on_hand} lowAt={level.low_at} /></td>
                            <td className="text-muted" title={dateTime(level.updated_at)}>{ago(level.updated_at)}</td>
                            <td>
                              <RowActions item={item} owner={owner} onAdjust={setAdjusting} onHistory={setHistory} onSettings={setConfiguring} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableScroll>
                </div>
                <ul className="divide-y divide-line md:hidden">
                  {shown.map(({ level, item }) => (
                    <li key={item.id} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-semibold">{item.name}</p>
                          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted">
                            <StockBadge onHand={level.on_hand} lowAt={level.low_at} /> Low at {level.low_at} · {ago(level.updated_at)}
                          </p>
                        </div>
                        <p className="tabular text-2xl font-extrabold">{level.on_hand}</p>
                      </div>
                      <div className="mt-2">
                        <RowActions item={item} owner={owner} onAdjust={setAdjusting} onHistory={setHistory} onSettings={setConfiguring} />
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Panel>
        </>
      )}

      {adjusting && stock && (
        <AdjustDrawer
          item={adjusting}
          level={stock.find((s) => s.menu_item_id === adjusting.id)!}
          onClose={() => setAdjusting(null)}
          onDone={() => {
            setAdjusting(null)
            changed()
          }}
        />
      )}
      {history && <HistoryDrawer item={history} onClose={() => setHistory(null)} />}
      {configuring && stock && (
        <ConfigureDrawer
          item={configuring === 'new' ? null : configuring}
          level={configuring === 'new' ? null : stock.find((s) => s.menu_item_id === configuring.id) ?? null}
          untracked={untracked}
          onClose={() => setConfiguring(null)}
          onDone={() => {
            setConfiguring(null)
            changed()
          }}
        />
      )}
    </PageBody>
  )
}

const rank = (l: StockLevel) => (l.on_hand <= 0 ? 0 : l.on_hand <= l.low_at ? 1 : 2)

function RowActions({
  item, owner, onAdjust, onHistory, onSettings,
}: { item: MenuItem; owner: boolean; onAdjust: (i: MenuItem) => void; onHistory: (i: MenuItem) => void; onSettings: (i: MenuItem) => void }) {
  return (
    <div className="flex items-center justify-end gap-1">
      <Button size="sm" variant="secondary" onClick={() => onAdjust(item)} aria-label={`Adjust stock for ${item.name}`}>
        Adjust
      </Button>
      {owner && (
        <>
          <Button size="sm" variant="ghost" onClick={() => onHistory(item)} aria-label={`Stock history for ${item.name}`} title="History">
            <IconHistory size={16} />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onSettings(item)} aria-label={`Stock settings for ${item.name}`} title="Settings">
            <IconSettings size={16} />
          </Button>
        </>
      )}
    </div>
  )
}

function AdjustDrawer({ item, level, onClose, onDone }: { item: MenuItem; level: StockLevel; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const qtyId = useId()
  const noteId = useId()
  const [kind, setKind] = useState<StockAdjustKind>('restock')
  const [qty, setQty] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const n = qty.trim() === '' ? NaN : Number(qty)
  const valid = Number.isInteger(n) && (kind === 'count' ? n >= 0 : kind === 'correction' ? n !== 0 : n > 0)
  const after = !valid ? null : kind === 'restock' ? level.on_hand + n : kind === 'waste' ? level.on_hand - n : kind === 'count' ? n : level.on_hand + n
  const tooMuch = after !== null && after < 0
  const needsNote = kind === 'correction' && !note.trim()
  const verb = kind === 'restock' ? `Add ${valid ? n : ''} to stock` : kind === 'waste' ? `Write off ${valid ? n : ''}` : kind === 'count' ? 'Save count' : 'Save correction'

  async function submit() {
    if (!valid || tooMuch || needsNote) {
      setError(!valid ? 'Enter a whole number.' : tooMuch ? `There are only ${level.on_hand} in stock.` : 'Add a short note explaining the correction.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await backend.adjustStock(item.id, kind, n, note.trim() || null)
      toast(`${item.name}: ${res.on_hand} in stock`, 'success')
      onDone()
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
      title={`Adjust ${item.name}`}
      description={`${level.on_hand} in stock now`}
      footer={
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose} className="flex-1">Cancel</Button>
          <Button onClick={() => void submit()} loading={busy} className="flex-[2]">{verb.trim()}</Button>
        </div>
      }
    >
      <div className="space-y-5 p-5">
        <fieldset>
          <legend className="label">What happened?</legend>
          <div className="grid grid-cols-2 gap-2">
            {ADJUST.map((a) => (
              <label key={a.kind} className={`cursor-pointer rounded-lg border p-3 ${kind === a.kind ? 'border-ink bg-sunken ring-1 ring-ink' : 'border-line-strong hover:border-ink'}`}>
                <input type="radio" name="adjust-kind" value={a.kind} checked={kind === a.kind} onChange={() => setKind(a.kind)} className="sr-only" />
                <span className="block text-sm font-bold">{a.label}</span>
                <span className="mt-0.5 block text-xs text-muted">{a.help}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <label htmlFor={qtyId} className="label">
            {kind === 'count' ? 'Counted on the shelf' : kind === 'correction' ? 'Change (use − to reduce)' : 'Quantity'}
          </label>
          <input
            id={qtyId}
            className="field-input tabular"
            inputMode={kind === 'correction' ? 'text' : 'numeric'}
            value={qty}
            onChange={(e) => setQty(e.target.value.replace(/[^\d-]/g, '').replace(/(?!^)-/g, ''))}
            placeholder={kind === 'correction' ? 'e.g. -2 or 3' : 'e.g. 20'}
            aria-invalid={tooMuch || undefined}
            autoFocus
          />
          <p className="mt-2 text-sm text-muted" aria-live="polite">
            {after === null ? 'Stock after this change will show here.' : (
              <>Stock: <span className="tabular font-bold text-ink">{level.on_hand}</span> → <span className={`tabular font-bold ${tooMuch ? 'text-danger' : 'text-ink'}`}>{after}</span></>
            )}
          </p>
        </div>
        <div>
          <label htmlFor={noteId} className="label">Note {kind === 'correction' ? '(required)' : '(optional)'}</label>
          {kind === 'waste' && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {WASTE_REASONS.map((r) => (
                <button key={r} type="button" className="rounded-full border border-line-strong px-3 py-1 text-xs font-semibold hover:border-ink" onClick={() => setNote(r)}>
                  {r}
                </button>
              ))}
            </div>
          )}
          <input id={noteId} className="field-input" maxLength={140} value={note} onChange={(e) => setNote(e.target.value)} placeholder={kind === 'restock' ? 'e.g. Morning batch' : ''} />
        </div>
        {error && <Banner tone="danger">{error}</Banner>}
      </div>
    </Dialog>
  )
}

function HistoryDrawer({ item, onClose }: { item: MenuItem; onClose: () => void }) {
  const [rows, setRows] = useState<StockMovement[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    backend.listStockMovements(item.id, 200).then(setRows, (e) => setError(friendlyError(e)))
  }, [item.id])
  return (
    <Dialog open drawer onClose={onClose} title={`${item.name} history`} description="Every change to the count, newest first.">
      {error ? (
        <div className="p-5"><Banner tone="danger">{error}</Banner></div>
      ) : !rows ? (
        <SkeletonRows label="Loading history" />
      ) : rows.length === 0 ? (
        <p className="p-5 text-sm text-muted">No changes yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((m) => (
            <li key={m.id} className="flex items-start gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{MOVEMENT_LABEL[m.kind]}</p>
                <p className="text-xs text-muted">
                  {dateTime(m.created_at)}
                  {m.actor_name && ` · ${m.actor_name}`}
                  {m.kind === 'waste' && m.unit_cost !== null && ` · ${money(-m.delta * m.unit_cost)} at cost`}
                </p>
                {m.note && <p className="mt-0.5 text-sm text-ink-2">“{m.note}”</p>}
              </div>
              <div className="text-right">
                <p className={`tabular text-sm font-bold ${m.delta < 0 ? 'text-danger' : m.delta > 0 ? 'text-ready' : 'text-muted'}`}>
                  {m.kind === 'initial' ? '' : m.delta > 0 ? '+' : m.delta < 0 ? '−' : '±'}
                  {Math.abs(m.delta)}
                </p>
                <p className="tabular text-xs text-muted">= {m.on_hand_after}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}

function ConfigureDrawer({
  item, level, untracked, onClose, onDone,
}: { item: MenuItem | null; level: StockLevel | null; untracked: MenuItem[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const itemId = useId()
  const onHandId = useId()
  const lowId = useId()
  const [choice, setChoice] = useState(item?.id ?? untracked[0]?.id ?? '')
  const [onHand, setOnHand] = useState('')
  const [lowAt, setLowAt] = useState(String(level?.low_at ?? 5))
  const [busy, setBusy] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isNew = !item
  const target = item ?? untracked.find((i) => i.id === choice) ?? null

  async function save() {
    const low = Number(lowAt)
    const start = Number(onHand || '0')
    if (!target) return
    if (!Number.isInteger(low) || low < 0 || (isNew && (!Number.isInteger(start) || start < 0))) {
      setError('Use whole numbers of 0 or more.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await backend.configureStock(target.id, true, low, isNew ? start : null)
      toast(isNew ? `Tracking ${target.name}` : `${target.name} updated`, 'success')
      onDone()
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  async function stop() {
    if (!item) return
    setBusy(true)
    try {
      await backend.configureStock(item.id, false, null, null)
      toast(`Stopped tracking ${item.name}`, 'success')
      onDone()
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
      title={isNew ? 'Track an item' : `${item.name} stock settings`}
      footer={
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose} className="flex-1">Cancel</Button>
          <Button onClick={() => void save()} loading={busy} disabled={!target} className="flex-[2]">{isNew ? 'Start tracking' : 'Save'}</Button>
        </div>
      }
    >
      <div className="space-y-5 p-5">
        {isNew && (
          <div>
            <label htmlFor={itemId} className="label">Item</label>
            <select id={itemId} className="field-input" value={choice} onChange={(e) => setChoice(e.target.value)}>
              {untracked.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </div>
        )}
        {isNew && (
          <div>
            <label htmlFor={onHandId} className="label">How many are ready now?</label>
            <input id={onHandId} className="field-input tabular" inputMode="numeric" value={onHand} onChange={(e) => setOnHand(e.target.value.replace(/\D/g, ''))} placeholder="0" />
          </div>
        )}
        <div>
          <label htmlFor={lowId} className="label">Warn me when it drops to</label>
          <input id={lowId} className="field-input tabular" inputMode="numeric" value={lowAt} onChange={(e) => setLowAt(e.target.value.replace(/\D/g, ''))} />
          <p className="mt-1.5 text-xs text-muted">Shown as “Low” here, with a badge on Inventory in the menu.</p>
        </div>
        <Banner tone="info">Each order reduces the count. A cancelled order puts the items back. At zero, students see the item as sold out.</Banner>
        {error && <Banner tone="danger">{error}</Banner>}
        {!isNew && (
          <div className="border-t border-line pt-5">
            {confirmStop ? (
              <div className="space-y-3">
                <p className="text-sm">Stop counting {item.name}? It will be orderable without a limit. Its history is kept.</p>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => setConfirmStop(false)}>Keep tracking</Button>
                  <Button variant="danger" onClick={() => void stop()} loading={busy}>Stop tracking {item.name}</Button>
                </div>
              </div>
            ) : (
              <Button variant="danger" size="sm" onClick={() => setConfirmStop(true)}>Stop tracking</Button>
            )}
          </div>
        )}
        {level && <p className="text-xs text-muted">Currently {level.on_hand} in stock.</p>}
      </div>
    </Dialog>
  )
}
