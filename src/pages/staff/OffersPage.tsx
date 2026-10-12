// Time-based deals: "20% off cold drinks, 3–6 pm, weekdays". Prices are still
// worked out by the database when an order is placed.
import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import { backend } from '../../backend'
import { PageBody, PageHeader, Panel, SkeletonRows, TableScroll } from '../../components/admin'
import { IconEdit, IconPlus, IconTrash } from '../../components/icons'
import { Banner, Button, Dialog, EmptyState, Switch, useToast } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { addDays, cafeDate, formatDay, money } from '../../lib/format'
import { cafeClock, daysLabel, discountFor, isOfferLive, windowLabel } from '../../lib/offers'
import type { MenuItem, Offer, OfferInput, OfferStat } from '../../lib/types'
import { usePublicData } from '../../state/publicData'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function status(o: Offer): { label: string; tone: string } {
  const today = cafeDate()
  if (!o.is_active) return { label: 'Paused', tone: 'bg-sunken text-ink-2' }
  if (o.valid_to && o.valid_to < today) return { label: 'Ended', tone: 'bg-sunken text-muted' }
  if (isOfferLive(o, cafeClock())) return { label: 'Live now', tone: 'bg-ready text-white' }
  return { label: 'Scheduled', tone: 'bg-brand-soft text-ink ring-1 ring-brand-strong/50' }
}

export function OffersPage() {
  const { data, refresh } = usePublicData()
  const toast = useToast()
  const [offers, setOffers] = useState<Offer[] | null>(null)
  const [stats, setStats] = useState<OfferStat[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Offer | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Offer | null>(null)
  const [busy, setBusy] = useState(false)
  const items = useMemo(() => data?.menu.items ?? [], [data])

  const load = useCallback(async () => {
    try {
      const [o, s] = await Promise.all([backend.listOffers(), backend.offerStats(addDays(cafeDate(), -29), cafeDate())])
      setOffers(o)
      setStats(s)
      setError(null)
    } catch (e) {
      setError(friendlyError(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const saved = () => {
    setEditing(null)
    void load()
    void refresh()
  }

  async function toggle(o: Offer, active: boolean) {
    try {
      await backend.saveOffer({ ...o, is_active: active })
      toast(active ? `${o.title} is on` : `${o.title} paused`, 'success')
      saved()
    } catch (e) {
      toast(friendlyError(e), 'error')
    }
  }

  async function remove() {
    if (!deleting) return
    setBusy(true)
    try {
      await backend.deleteOffer(deleting.id)
      toast('Offer deleted', 'success')
      setDeleting(null)
      saved()
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const itemNames = (o: Offer) =>
    o.menu_item_ids.length === 0 ? 'Whole menu' : o.menu_item_ids.map((id) => items.find((i) => i.id === id)?.name ?? 'Removed item').join(', ')

  return (
    <PageBody>
      <PageHeader
        title="Offers"
        subtitle="Discounts that switch on and off by themselves — happy hours, weekday deals, combo days."
        actions={<Button onClick={() => setEditing('new')}><IconPlus size={16} /> New offer</Button>}
      />
      {error && <Banner tone="danger" className="mb-4">{error}</Banner>}

      <Panel title="Your offers" flush>
        {!offers ? (
          <SkeletonRows rows={3} label="Loading offers" />
        ) : offers.length === 0 ? (
          <EmptyState title="No offers yet" action={<Button onClick={() => setEditing('new')}><IconPlus size={16} /> Create your first offer</Button>}>
            Try “Cool-down hour: 20% off cold drinks, 3–6 pm” to fill the quiet afternoon.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {offers.map((o) => {
              const st = status(o)
              return (
                <li key={o.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 sm:px-5">
                  <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-brand text-base font-extrabold text-ink">{o.percent_off}%</span>
                  <div className="min-w-0 flex-1 basis-60">
                    <p className="flex flex-wrap items-center gap-2 font-bold">
                      {o.title} <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${st.tone}`}>{st.label}</span>
                    </p>
                    <p className="truncate text-sm text-muted">{itemNames(o)}</p>
                    <p className="text-sm text-ink-2">
                      {daysLabel(o.days)} · {windowLabel(o)}
                      {(o.valid_from || o.valid_to) && (
                        <> · {o.valid_from ? formatDay(o.valid_from) : 'now'} – {o.valid_to ? formatDay(o.valid_to) : 'no end date'}</>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch checked={o.is_active} onChange={(v) => void toggle(o, v)} label={`${o.title} on or off`} />
                    <Button size="sm" variant="secondary" onClick={() => setEditing(o)} aria-label={`Edit ${o.title}`}><IconEdit size={15} /> Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(o)} aria-label={`Delete ${o.title}`}><IconTrash size={15} /></Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Panel>

      <Panel title="How offers did" description="Last 30 days · cancelled orders excluded" className="mt-4" flush>
        {!stats ? (
          <SkeletonRows rows={2} />
        ) : stats.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">No orders with an offer yet.</p>
        ) : (
          <TableScroll label="Offer results">
            <table className="dt min-w-[560px]">
              <thead>
                <tr>
                  <th>Offer</th>
                  <th className="num">Orders</th>
                  <th className="num">Items sold</th>
                  <th className="num">Sales</th>
                  <th className="num">Discount given</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <tr key={s.title}>
                    <td className="font-semibold">{s.title}</td>
                    <td className="num">{s.orders}</td>
                    <td className="num">{s.units}</td>
                    <td className="num">{money(s.sales)}</td>
                    <td className="num">{money(s.discount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>

      {editing && (
        <OfferEditor key={editing === 'new' ? 'new' : editing.id} offer={editing === 'new' ? null : editing} items={items} onClose={() => setEditing(null)} onSaved={saved} />
      )}

      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.title ?? 'offer'}?`}
        size="sm"
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setDeleting(null)}>Keep</Button>
            <Button variant="danger" className="flex-1" loading={busy} onClick={() => void remove()}>Delete</Button>
          </div>
        }
      >
        <p className="p-5 text-sm">Students stop seeing it straight away. Past orders keep the discount they got. To stop it for now, pause it instead.</p>
      </Dialog>
    </PageBody>
  )
}

function OfferEditor({ offer, items, onClose, onSaved }: { offer: Offer | null; items: MenuItem[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const ids = useId()
  const [title, setTitle] = useState(offer?.title ?? '')
  const [percent, setPercent] = useState(String(offer?.percent_off ?? 10))
  const [whole, setWhole] = useState(offer ? offer.menu_item_ids.length === 0 : false)
  const [chosen, setChosen] = useState<string[]>(offer?.menu_item_ids ?? [])
  const [days, setDays] = useState<number[]>(offer?.days ?? [])
  const allDay = (o: Offer | null) => !o || (o.starts_at.startsWith('00:00') && o.ends_at.startsWith('24:00'))
  const [timed, setTimed] = useState(!allDay(offer))
  const [from, setFrom] = useState(offer && !allDay(offer) ? offer.starts_at.slice(0, 5) : '15:00')
  const [to, setTo] = useState(offer && !allDay(offer) ? offer.ends_at.slice(0, 5) : '18:00')
  const [validFrom, setValidFrom] = useState(offer?.valid_from ?? '')
  const [validTo, setValidTo] = useState(offer?.valid_to ?? '')
  const [active, setActive] = useState(offer?.is_active ?? true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const pct = Number(percent)
  const sample = items.find((i) => (whole ? i.is_available : chosen.includes(i.id)))

  async function submit(e: FormEvent) {
    e.preventDefault()
    const name = title.trim()
    if (!name) return setError('Give the offer a short name students will see, like “Cool-down hour”.')
    if (!Number.isInteger(pct) || pct < 1 || pct > 90) return setError('The discount must be a whole number from 1 to 90 %.')
    if (!whole && chosen.length === 0) return setError('Choose at least one item, or apply it to the whole menu.')
    if (timed && to <= from) return setError('The end time must be after the start time (offers can’t run past midnight).')
    if (validFrom && validTo && validTo < validFrom) return setError('The end date is before the start date.')
    const input: OfferInput = {
      id: offer?.id,
      title: name,
      percent_off: pct,
      menu_item_ids: whole ? [] : chosen,
      days,
      starts_at: timed ? `${from}:00` : '00:00:00',
      ends_at: timed ? `${to}:00` : '24:00:00',
      valid_from: validFrom || null,
      valid_to: validTo || null,
      is_active: active,
    }
    setBusy(true)
    setError(null)
    try {
      await backend.saveOffer(input)
      toast(offer ? 'Offer saved' : 'Offer created', 'success')
      onSaved()
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      drawer
      onClose={onClose}
      title={offer ? `Edit ${offer.title}` : 'New offer'}
      footer={
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button className="flex-1" type="submit" form={`${ids}-form`} loading={busy}>{offer ? 'Save offer' : 'Create offer'}</Button>
        </div>
      }
    >
      <form id={`${ids}-form`} onSubmit={submit} noValidate className="space-y-5 p-5">
        <div>
          <label className="label" htmlFor={`${ids}-title`}>Name students see</label>
          <input id={`${ids}-title`} className="field-input" maxLength={40} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Cool-down hour" />
        </div>
        <div>
          <label className="label" htmlFor={`${ids}-pct`}>Discount</label>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-28">
              <input id={`${ids}-pct`} className="field-input pr-8" inputMode="numeric" value={percent} onChange={(e) => setPercent(e.target.value.replace(/\D/g, '').slice(0, 2))} />
              <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-bold text-muted">%</span>
            </div>
            {[10, 15, 20, 25].map((p) => (
              <button key={p} type="button" className="chip" aria-pressed={pct === p} onClick={() => setPercent(String(p))}>{p}%</button>
            ))}
          </div>
          {sample && pct >= 1 && pct <= 90 && (
            <p className="mt-1.5 text-sm text-muted">
              e.g. {sample.name}: {money(sample.price)} → <strong className="text-ink">{money(sample.price - discountFor(sample.price, pct))}</strong> (add-ons stay full price)
            </p>
          )}
        </div>

        <fieldset>
          <legend className="label">Applies to</legend>
          <div className="flex gap-2">
            <button type="button" className="chip" aria-pressed={!whole} onClick={() => setWhole(false)}>Chosen items</button>
            <button type="button" className="chip" aria-pressed={whole} onClick={() => setWhole(true)}>Whole menu</button>
          </div>
          {!whole && (
            <div className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-line">
              {items.map((i) => (
                <label key={i.id} className="flex min-h-11 items-center gap-3 border-b border-line px-3 last:border-0">
                  <input
                    type="checkbox"
                    className="size-4.5 accent-ink"
                    checked={chosen.includes(i.id)}
                    onChange={(e) => setChosen((c) => (e.target.checked ? [...c, i.id] : c.filter((x) => x !== i.id)))}
                  />
                  <span className="flex-1 text-sm font-semibold">{i.name}</span>
                  <span className="tabular text-sm text-muted">{money(i.price)}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <fieldset>
          <legend className="label">Days <span className="font-normal text-muted">(none selected = every day)</span></legend>
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map((d, i) => (
              <button
                key={d}
                type="button"
                className="chip min-w-12 justify-center"
                aria-pressed={days.includes(i + 1)}
                onClick={() => setDays((ds) => (ds.includes(i + 1) ? ds.filter((x) => x !== i + 1) : [...ds, i + 1].sort()))}
              >
                {d}
              </button>
            ))}
          </div>
          <p className="mt-1 text-sm text-muted">{daysLabel(days)}</p>
        </fieldset>

        <fieldset>
          <legend className="label">Time</legend>
          <div className="flex gap-2">
            <button type="button" className="chip" aria-pressed={!timed} onClick={() => setTimed(false)}>All day</button>
            <button type="button" className="chip" aria-pressed={timed} onClick={() => setTimed(true)}>Between…</button>
          </div>
          {timed && (
            <div className="mt-2 flex items-end gap-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-muted" htmlFor={`${ids}-from`}>From</label>
                <input id={`${ids}-from`} type="time" className="field-input" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-muted" htmlFor={`${ids}-to`}>To</label>
                <input id={`${ids}-to`} type="time" className="field-input" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </div>
          )}
        </fieldset>

        <fieldset>
          <legend className="label">Dates <span className="font-normal text-muted">(optional)</span></legend>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-muted" htmlFor={`${ids}-vf`}>Starts on</label>
              <input id={`${ids}-vf`} type="date" className="field-input" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-muted" htmlFor={`${ids}-vt`}>Ends on</label>
              <input id={`${ids}-vt`} type="date" className="field-input" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
            </div>
          </div>
        </fieldset>

        <label className="flex items-center justify-between gap-3 rounded-xl bg-sunken px-3 py-2.5">
          <span>
            <span className="block font-bold">Offer is on</span>
            <span className="block text-sm text-muted">Turn off to pause it without deleting.</span>
          </span>
          <Switch checked={active} onChange={setActive} label="Offer is on" />
        </label>

        {error && <Banner tone="danger">{error}</Banner>}
      </form>
    </Dialog>
  )
}
