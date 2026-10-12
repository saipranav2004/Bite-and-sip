import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { backend } from '../../backend'
import { FoodImage } from '../../components/FoodArt'
import { IconArrowRight, IconBag, IconClock, IconPin, IconRefresh, IconSearch, IconX } from '../../components/icons'
import { SiteFooter } from '../../components/SiteFooter'
import { DemoRibbon, StudentHeader } from '../../components/StudentShell'
import { Banner, Button, EmptyState, QuantityStepper, useToast, VegMark } from '../../components/ui'
import { useT, type Translate } from '../../i18n'
import { money } from '../../lib/format'
import { flyToCart } from '../../lib/motion'
import { endTime, liveOffers } from '../../lib/offers'
import { lineKey, offerPrice, priceCart } from '../../lib/pricing'
import { lowStockLeft, stockLeft } from '../../lib/stock'
import { readJson, writeJson } from '../../lib/storage'
import type { CustomerOrder, KitchenEta, MenuItem, Offer } from '../../lib/types'
import { useMinuteClock } from '../../hooks/useMinuteClock'
import { Price } from '../../components/Price'
import { useCart } from '../../state/cart'
import { currentTable, myOrderRefs } from '../../state/device'
import { useStudentData } from '../../state/publicData'
import { HelpButton } from './HelpButton'
import { ItemSheet } from './ItemSheet'
import { useReorder } from './useReorder'

const VEG_KEY = 'bitesip-veg-only-v1'

export function MenuPage() {
  const { data, loading, error, refresh } = useStudentData()
  const cart = useCart()
  const toast = useToast()
  const navigate = useNavigate()
  const { t } = useT()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string>('all')
  const [vegOnly, setVegOnly] = useState(() => readJson<boolean>(VEG_KEY, false) === true)
  const [selected, setSelected] = useState<MenuItem | null>(null)
  const scanned = currentTable()
  const clock = useMinuteClock()

  const categories = useMemo(() => (data ? [...data.menu.categories].sort((a, b) => a.sort_order - b.sort_order) : []), [data])
  const catName = (id: string) => categories.find((c) => c.id === id)?.name ?? ''

  const q = query.trim().toLowerCase()
  const visible = useMemo(() => {
    if (!data) return []
    return data.menu.items.filter(
      (i) =>
        (category === 'all' || i.category_id === category) &&
        (!vegOnly || i.is_veg) &&
        (!q || i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q) || catName(i.category_id).toLowerCase().includes(q)),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, category, q, vegOnly])

  const offers = useMemo(() => data?.offers ?? [], [data])
  const live = useMemo(() => liveOffers(offers, clock), [offers, clock])
  const table = scanned && data?.tables.some((t) => t.is_active && t.label === scanned) ? scanned : null
  const popular = data?.menu.items.filter((i) => i.is_popular && i.is_available && (!vegOnly || i.is_veg)) ?? []
  const priced = data ? priceCart(cart.lines, data.menu.items, offers, clock) : null
  const isOpen = data?.settings.is_open ?? true

  // Bounce the cart bar whenever something new lands in it.
  const units = priced?.units ?? 0
  const prevUnits = useRef(units)
  const [bump, setBump] = useState(0)
  useEffect(() => {
    if (units > prevUnits.current) setBump((b) => b + 1)
    prevUnits.current = units
  }, [units])

  /** How many more of a tracked item fit, after what's already in the cart (null = no limit). */
  const roomFor = (itemId: string) => {
    const left = data ? stockLeft(itemId, data.stock) : null
    if (left === null) return null
    return Math.max(0, left - cart.lines.filter((l) => l.menu_item_id === itemId).reduce((n, l) => n + l.quantity, 0))
  }

  const addPlain = (item: MenuItem, from?: Element | null) => {
    flyToCart(from ?? null)
    cart.add(item.id, [], 1, '')
    toast(t('menu.added', { name: item.name }), 'success')
  }

  const toggleVeg = () => {
    setVegOnly((v) => {
      writeJson(VEG_KEY, !v)
      return !v
    })
  }

  if (loading && !data) return <MenuSkeleton />
  if (!data)
    return (
      <>
        <DemoRibbon />
        <StudentHeader />
        <EmptyState icon={<IconRefresh />} title={t('menu.loadFailed')} action={<Button onClick={() => void refresh()}>{t('menu.tryAgain')}</Button>}>
          {t('menu.loadFailedBody')}
        </EmptyState>
      </>
    )

  const grouped = categories
    .map((c) => ({ category: c, items: visible.filter((i) => i.category_id === c.id) }))
    .filter((g) => g.items.length > 0)

  return (
    <div className="min-h-dvh">
      <DemoRibbon />
      <StudentHeader />
      <section data-hero className="rounded-b-[1.75rem] bg-ink px-4 pt-2 pb-5 text-white">
        <div className="mx-auto max-w-3xl md:px-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-brand px-3 text-sm font-bold text-ink">
              <IconPin size={16} />
              {table ? t('menu.tablePill', { table }) : t('menu.counterPill')}
            </p>
            {table && isOpen && <HelpButton table={table} />}
          </div>
          <h1 className="mt-3 text-[1.6rem] leading-[1.15] font-extrabold tracking-tight sm:text-4xl">
            {t('menu.title1')} <span className="text-brand">{t('menu.title2')}</span>
          </h1>
          <p className="mt-1.5 text-sm text-white/75 sm:text-[15px]">
            {table ? t('menu.subTable', { table }) : t('menu.subCounter')}
          </p>
          {isOpen && data.eta && <EtaChip eta={data.eta} t={t} />}
          {error && <p className="mt-2 text-sm font-semibold text-brand">{t('menu.staleError', { error })}</p>}
        </div>
      </section>
      <main className="mx-auto max-w-3xl px-4">
        {!isOpen && (
          <Banner tone="warning" title={t('menu.closedTitle')} className="my-3">
            {t('menu.closedBody', { message: data.settings.closed_message })}
          </Banner>
        )}

        {live.length > 0 && <OfferStrip offers={live} items={data.menu.items} t={t} />}
        {isOpen && <LastOrder />}

        <div className="sticky top-16 z-20 -mx-4 bg-canvas/95 px-4 pt-3 pb-3 backdrop-blur supports-[backdrop-filter]:bg-canvas/85">
          <div className="relative">
            <IconSearch className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-subtle" />
            <input
              type="search"
              inputMode="search"
              aria-label={t('menu.search')}
              placeholder={t('menu.searchPlaceholder')}
              className="field-input pr-11 pl-11"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute top-1/2 right-1.5 grid size-9 -translate-y-1/2 place-items-center rounded-full text-muted hover:bg-sunken"
                aria-label={t('menu.clearSearch')}
              >
                <IconX size={18} />
              </button>
            )}
          </div>
          <div className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none]" role="group" aria-label={t('menu.categories')}>
            <button type="button" className="chip shrink-0 gap-1.5" aria-pressed={vegOnly} onClick={toggleVeg}>
              <VegMark veg label={t('item.veg')} /> {t('menu.vegOnly')}
            </button>
            <span className="my-1 w-px shrink-0 bg-line-strong" aria-hidden="true" />
            <button type="button" className="chip shrink-0" aria-pressed={category === 'all'} onClick={() => setCategory('all')}>
              {t('menu.all')}
            </button>
            {categories.map((c) => (
              <button key={c.id} type="button" className="chip shrink-0" aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>
                {c.name}
              </button>
            ))}
          </div>
        </div>

        {category === 'all' && !q && popular.length > 0 && (
          <section aria-labelledby="popular-h" className="mt-3">
            <h2 id="popular-h" className="text-lg font-extrabold">{t('menu.popular')}</h2>
            <div className="-mx-4 mt-3 flex snap-x gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none]">
              {popular.map((item, i) => {
                const p = offerPrice(item, offers, clock)
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelected(item)}
                    style={{ animationDelay: `${i * 70}ms` }}
                    className="card animate-rise w-40 shrink-0 snap-start overflow-hidden text-left transition-transform active:scale-[0.98]"
                  >
                    <FoodImage name={item.name} category={catName(item.category_id)} path={item.image_path} className="aspect-[4/3] w-full" />
                    <span className="block px-3 pt-2 pb-3">
                      <span className="line-clamp-1 text-sm font-bold">{item.name}</span>
                      <Price price={p.price} was={p.was} className="text-sm" />
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
        )}

        {grouped.length === 0 ? (
          <EmptyState
            icon={<IconSearch />}
            title={q ? t('menu.nothingMatches', { query: query.trim() }) : vegOnly ? t('menu.noVeg') : t('menu.nothingHere')}
            action={
              <Button variant="secondary" onClick={() => { setQuery(''); setCategory('all'); if (vegOnly) toggleVeg() }}>
                {t('menu.showAll')}
              </Button>
            }
          >
            {q ? t('menu.nothingHint') : null}
          </EmptyState>
        ) : (
          grouped.map(({ category: c, items }, gi) => (
            <section key={c.id} aria-labelledby={`cat-${c.id}`} className="mt-6">
              <h2 id={`cat-${c.id}`} className="text-lg font-extrabold">
                {c.name} <span className="text-sm font-semibold text-subtle">· {items.length}</span>
              </h2>
              <ul className="mt-2 divide-y divide-line">
                {items.map((item, i) => {
                  const left = lowStockLeft(item.id, data.stock)
                  return (
                    <MenuRow
                      key={item.id}
                      delay={Math.min(gi * 90 + i * 45, 520)}
                      item={item}
                      offer={offerPrice(item, offers, clock)}
                      categoryName={c.name}
                      disabled={!isOpen}
                      plainQty={cart.plainQuantity(item.id)}
                      room={roomFor(item.id)}
                      lowNote={left === null ? null : t('menu.onlyLeft', { count: left })}
                      onOpen={() => setSelected(item)}
                      onAdd={(from) => (item.addons.length ? setSelected(item) : addPlain(item, from))}
                      onSetPlain={(n) => cart.setQuantity(lineKey(item.id, [], ''), n)}
                    />
                  )
                })}
              </ul>
            </section>
          ))
        )}
      </main>
      <SiteFooter />

      <ItemSheet
        key={selected?.id ?? 'none'}
        item={selected}
        offers={offers}
        categoryName={selected ? catName(selected.category_id) : undefined}
        open={!!selected}
        disabled={!isOpen}
        room={selected ? roomFor(selected.id) : null}
        onClose={() => setSelected(null)}
        onAdd={(addonIds, qty, note) => {
          if (!selected) return
          cart.add(selected.id, addonIds, qty, note)
          toast(t('menu.added', { name: selected.name }), 'success')
        }}
      />

      {priced && priced.units > 0 && (
        <div className="animate-rise fixed inset-x-0 bottom-0 z-30 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={() => navigate('/cart', { viewTransition: true })}
            className="mx-auto flex min-h-15 w-full max-w-3xl items-center gap-3 rounded-2xl bg-ink px-4 text-left text-white shadow-[var(--shadow-float)]"
          >
            <span key={`bag-${bump}`} data-cart-target className={`grid size-9 place-items-center rounded-full bg-brand text-ink ${bump ? 'animate-bump' : ''}`}>
              <IconBag size={18} />
            </span>
            <span key={`sum-${bump}`} className={`flex-1 ${bump ? 'animate-bump' : ''}`}>
              <span className="block text-sm font-semibold text-white/75">
                {priced.units === 1 ? t('menu.item') : t('menu.items', { count: priced.units })}
              </span>
              <span className="tabular block text-lg leading-tight font-extrabold">{money(priced.total)}</span>
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2.5 font-extrabold text-ink">
              {t('menu.viewCart')} <IconArrowRight size={18} />
            </span>
          </button>
        </div>
      )}
    </div>
  )
}

function EtaChip({ eta, t }: { eta: KitchenEta; t: Translate }) {
  const busy = eta.queue >= 5
  return (
    <p className={`mt-3 inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 text-sm font-bold ${busy ? 'bg-white/15 text-brand' : 'bg-white/10 text-white'}`} title={t('eta.title')}>
      <IconClock size={15} />
      {busy ? t('eta.busy', { minutes: eta.minutes }) : t('eta.quiet', { minutes: eta.minutes })}
    </p>
  )
}

function OfferStrip({ offers, items, t }: { offers: Offer[]; items: MenuItem[]; t: Translate }) {
  const names = (o: Offer) => {
    if (o.menu_item_ids.length === 0) return t('offers.allItems')
    const n = o.menu_item_ids.map((id) => items.find((i) => i.id === id)?.name).filter(Boolean) as string[]
    return n.length > 3 ? `${n.slice(0, 3).join(', ')} ${t('offers.more', { count: n.length - 3 })}` : n.join(', ')
  }
  return (
    <section aria-label={t('offers.title')} className="mt-3 space-y-2">
      {offers.slice(0, 2).map((o) => {
        const ends = endTime(o)
        return (
          <div key={o.id} className="flex items-start gap-3 rounded-2xl border border-brand-strong/50 bg-brand-soft p-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand text-sm font-extrabold text-ink">{o.percent_off}%</span>
            <span className="min-w-0 flex-1">
              <span className="block font-extrabold">{o.title}</span>
              <span className="block text-sm text-ink-2">{t('offers.on', { percent: o.percent_off, items: names(o) })}</span>
            </span>
            <span className="shrink-0 text-xs font-bold text-brand-ink">
              {ends ? t('offers.ends', { time: ends }) : t('offers.endsToday')}
            </span>
          </div>
        )
      })}
      {offers.length > 2 && <p className="text-xs font-semibold text-muted">{t('offers.more', { count: offers.length - 2 })}</p>}
    </section>
  )
}

/** "Order again" for the last completed order on this phone. */
function LastOrder() {
  const { t } = useT()
  const reorder = useReorder()
  const [last, setLast] = useState<CustomerOrder | null>(null)
  useEffect(() => {
    const refs = myOrderRefs().slice(0, 5)
    if (refs.length === 0) return
    let alive = true
    backend
      .getOrders(refs.map((r) => ({ id: r.id, token: r.token })))
      .then((orders) => {
        if (!alive) return
        const done = orders.filter((o) => o.status === 'completed').sort((a, b) => b.created_at.localeCompare(a.created_at))
        setLast(done[0] ?? null)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  if (!last) return null
  return (
    <section aria-label={t('again.title')} className="card mt-3 flex items-center gap-3 p-3">
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-bold tracking-wide text-muted uppercase">{t('again.last')}</span>
        <span className="block truncate text-sm font-semibold">{last.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}</span>
      </span>
      <Button size="sm" variant="dark" onClick={() => reorder(last)}>
        <IconRefresh size={15} /> {t('again.button')}
      </Button>
    </section>
  )
}

function MenuRow({
  item, offer, categoryName, plainQty, disabled, delay, onOpen, onAdd, onSetPlain, room, lowNote,
}: {
  room: number | null
  lowNote: string | null
  item: MenuItem
  offer: ReturnType<typeof offerPrice>
  delay: number
  categoryName: string
  plainQty: number
  disabled: boolean
  onOpen: () => void
  onAdd: (from: Element | null) => void
  onSetPlain: (n: number) => void
}) {
  const { t } = useT()
  const customisable = item.addons.length > 0
  const photo = useRef<HTMLSpanElement>(null)
  return (
    <li className="animate-rise flex gap-3 py-4" style={{ animationDelay: `${delay}ms` }}>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 gap-3 text-left" aria-label={t('menu.viewDetails', { name: item.name, price: money(offer.price) })}>
        <span ref={photo} className="relative size-20 shrink-0 overflow-hidden rounded-2xl ring-1 ring-line sm:size-24">
          <FoodImage name={item.name} category={categoryName} path={item.image_path} className={`size-full ${item.is_available ? '' : 'grayscale'}`} />
          {offer.offer && item.is_available && (
            <span className="absolute top-1 left-1 rounded-md bg-brand px-1.5 py-0.5 text-[11px] font-extrabold text-ink">{t('menu.off', { percent: offer.offer.percent_off })}</span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <VegMark veg={item.is_veg} label={t(item.is_veg ? 'item.veg' : 'item.nonVeg')} />
            {item.is_popular && <span className="text-xs font-bold text-brand-ink">{t('menu.popularTag')}</span>}
          </span>
          <span className={`mt-1 block font-bold leading-snug ${item.is_available ? '' : 'text-muted'}`}>{item.name}</span>
          {item.description && <span className="mt-0.5 line-clamp-2 block text-sm text-muted">{item.description}</span>}
          <span className="mt-1 block">
            <Price price={offer.price} was={offer.was} />
            {lowNote && item.is_available && <span className="ml-2 text-xs font-bold text-brand-ink">{lowNote}</span>}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 flex-col items-end justify-center gap-1">
        {!item.is_available ? (
          <span className="rounded-full bg-sunken px-3 py-1.5 text-xs font-bold text-muted">{t('menu.soldOut')}</span>
        ) : plainQty > 0 && !customisable ? (
          <QuantityStepper size="sm" value={plainQty} min={0} max={room === null ? 20 : Math.min(20, plainQty + room)} onChange={onSetPlain} label={item.name} />
        ) : (
          <Button size="sm" variant="secondary" disabled={disabled || room === 0} onClick={() => onAdd(photo.current)} className="min-w-20 border-ink font-extrabold" aria-label={t('menu.addItem', { name: item.name })}>
            {t('menu.add')}
          </Button>
        )}
        {customisable && item.is_available && <span className="text-[11px] font-semibold text-subtle">{t('menu.customisable')}</span>}
      </div>
    </li>
  )
}

function MenuSkeleton() {
  const { t } = useT()
  return (
    <div aria-busy="true" aria-label={t('menu.loading')}>
      <DemoRibbon />
      <StudentHeader />
      <div className="mx-auto max-w-3xl animate-pulse px-4 pt-6">
        <div className="h-7 w-40 rounded-full bg-sunken" />
        <div className="mt-4 h-9 w-3/4 rounded-xl bg-sunken" />
        <div className="mt-5 h-12 rounded-xl bg-sunken" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="mt-5 flex gap-3">
            <div className="size-20 rounded-2xl bg-sunken" />
            <div className="flex-1 space-y-2 pt-1">
              <div className="h-4 w-1/2 rounded bg-sunken" />
              <div className="h-3 w-3/4 rounded bg-sunken" />
              <div className="h-4 w-16 rounded bg-sunken" />
            </div>
          </div>
        ))}
      </div>
      <p className="sr-only" role="status">{t('menu.loading')}</p>
    </div>
  )
}
