import { useId, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { backend } from '../../backend'
import { FoodImage } from '../../components/FoodArt'
import { IconBag, IconClock, IconPin, IconTrash } from '../../components/icons'
import { DemoRibbon, StudentHeader } from '../../components/StudentShell'
import { Banner, Button, EmptyState, QuantityStepper, Spinner } from '../../components/ui'
import { useMinuteClock } from '../../hooks/useMinuteClock'
import { useT, type MessageKey } from '../../i18n'
import { toAppError } from '../../lib/errors'
import { money } from '../../lib/format'
import { cafeClock } from '../../lib/offers'
import { priceCart, type LineIssue } from '../../lib/pricing'
import { pickupSlots, slotLabel } from '../../lib/schedule'
import { newAccessToken, newId } from '../../lib/tokens'
import type { PaymentMethod, PlaceOrderInput } from '../../lib/types'
import { cleanText, normalizePhone } from '../../lib/validation'
import { useCart } from '../../state/cart'
import {
  currentTable, pendingOrder, rememberOrder, savedDetails, saveDetails, setCurrentTable, setPendingOrder,
} from '../../state/device'
import { useStudentData } from '../../state/publicData'

const ISSUE_KEY: Record<LineIssue, MessageKey> = {
  item_missing: 'cart.issue.item_missing',
  item_unavailable: 'cart.issue.item_unavailable',
  addon_unavailable: 'cart.issue.addon_unavailable',
}

function nameError(v: string): MessageKey | null {
  const c = cleanText(v)
  if (!c) return 'val.name'
  if (c.length > 40) return 'val.nameLong'
  return null
}

function phoneError(v: string): MessageKey | null {
  if (!v.trim()) return 'val.phone'
  return normalizePhone(v) ? null : 'val.phoneInvalid'
}

export function CartPage() {
  const { data, loading, refresh } = useStudentData()
  const cart = useCart()
  const navigate = useNavigate()
  const { t, tError } = useT()
  const saved = savedDetails()
  const [name, setName] = useState(saved.name)
  const [phone, setPhone] = useState(saved.phone)
  const [method, setMethod] = useState<PaymentMethod | null>(null)
  const [when, setWhen] = useState<'now' | 'later'>('now')
  const [slot, setSlot] = useState<string>('')
  const [errors, setErrors] = useState<{ name?: MessageKey; phone?: MessageKey; method?: MessageKey }>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [scanned, setScanned] = useState(currentTable())
  const nameId = useId()
  const phoneId = useId()
  const clock = useMinuteClock()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const slots = useMemo(() => pickupSlots(), [clock.minutes])
  // The chosen time is never swapped silently: if it drops out of the list, the student picks again.
  const chosenSlot = when === 'later' ? (slots.find((s) => s.iso === slot) ?? null) : null
  const slotGone = when === 'later' && !chosenSlot

  if (loading && !data) {
    return (
      <>
        <DemoRibbon />
        <StudentHeader back="/" title={t('header.cart')} right={<span />} />
        <div className="grid place-items-center py-24"><Spinner label={t('cart.loading')} /></div>
      </>
    )
  }

  const items = data?.menu.items ?? []
  const offers = data?.offers ?? []
  const priced = priceCart(cart.lines, items, offers, clock)
  const settings = data?.settings
  const upiAvailable = !!settings?.upi_id
  const isOpen = settings?.is_open ?? false
  const table = scanned && data?.tables.some((tb) => tb.is_active && tb.label === scanned) ? scanned : null

  if (cart.lines.length === 0) {
    return (
      <>
        <DemoRibbon />
        <StudentHeader back="/" title={t('header.cart')} right={<span />} />
        <EmptyState icon={<IconBag />} title={t('cart.empty')} action={<Button onClick={() => navigate('/', { viewTransition: true })}>{t('cart.browse')}</Button>}>
          {t('cart.emptyBody')}
        </EmptyState>
      </>
    )
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setSubmitError(null)
    setNotice(null)
    const nextErrors = {
      name: nameError(name) ?? undefined,
      phone: phoneError(phone) ?? undefined,
      method: method ? undefined : ('cart.chooseMethod' as const),
    }
    setErrors(nextErrors)
    if (nextErrors.name || nextErrors.phone || nextErrors.method) {
      const first = nextErrors.name ? nameId : nextErrors.phone ? phoneId : 'payment-method'
      document.getElementById(first)?.focus()
      return
    }
    if (priced.hasIssues || !isOpen || !method) return
    if (slotGone) {
      document.getElementById('pickup-time')?.focus()
      return
    }

    setSubmitting(true)
    try {
      // Re-check prices and availability against the latest menu and offers before sending.
      const fresh = await backend.getPublicData()
      const check = priceCart(cart.lines, fresh.menu.items, fresh.offers, cafeClock())
      if (!fresh.settings.is_open || check.hasIssues || check.total !== priced.total) {
        await refresh()
        setNotice(
          !fresh.settings.is_open
            ? t('cart.justClosed')
            : check.hasIssues
              ? t('cart.justSoldOut')
              : t('cart.pricesChanged', { total: money(check.total) }),
        )
        return
      }

      const cleanName = cleanText(name)
      const cleanPhone = normalizePhone(phone)!
      saveDetails({ name: cleanName, phone: cleanPhone })
      const input: Omit<PlaceOrderInput, 'client_request_id' | 'access_token'> = {
        customer_name: cleanName,
        customer_phone: cleanPhone,
        payment_method: method,
        table_label: table,
        items: cart.lines.map((l) => ({ menu_item_id: l.menu_item_id, quantity: l.quantity, addon_ids: l.addon_ids, note: l.note || null })),
        scheduled_for: chosenSlot?.iso ?? null,
        expected_total: check.total,
      }
      // Reuse the same request id + secret if a previous attempt for this exact
      // cart may have reached the server, so a retry can never create a duplicate.
      const fingerprint = JSON.stringify(input)
      const prev = pendingOrder()
      const ids = prev && prev.fingerprint === fingerprint ? prev : { client_request_id: newId(), access_token: newAccessToken(), fingerprint }
      setPendingOrder(ids)

      const order = await backend.placeOrder({ ...input, client_request_id: ids.client_request_id, access_token: ids.access_token })
      rememberOrder({ id: order.id, token: ids.access_token, order_no: order.order_no, created_at: order.created_at })
      setPendingOrder(null)
      cart.clear()
      navigate(`/order/${order.id}`, { replace: true, state: { justPlaced: true }, viewTransition: true })
    } catch (err) {
      const appErr = toAppError(err)
      if (appErr.code !== 'network' && appErr.code !== 'unknown') setPendingOrder(null)
      if (appErr.code === 'prices_changed') {
        const fresh = await backend.getPublicData().catch(() => null)
        await refresh()
        const total = fresh ? priceCart(cart.lines, fresh.menu.items, fresh.offers, cafeClock()).total : null
        setNotice(total === null ? tError(appErr) : t('cart.pricesChanged', { total: money(total) }))
        return
      }
      if (appErr.code === 'invalid_pickup_time') {
        setSlot('')
        setNotice(t('cart.timePassed'))
        return
      }
      if (['item_unavailable', 'addon_unavailable', 'item_not_found', 'cafe_closed', 'upi_unavailable', 'insufficient_stock'].includes(appErr.code)) void refresh()
      setSubmitError(tError(appErr))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-dvh pb-10">
      <DemoRibbon />
      <StudentHeader back="/" title={t('header.cart')} right={<span />} />
      <form onSubmit={submit} noValidate className="mx-auto max-w-3xl space-y-6 px-4 pt-4">
        {!isOpen && settings && (
          <Banner tone="warning" title={t('menu.closedTitle')}>
            {t('cart.closedBody', { message: settings.closed_message })}
          </Banner>
        )}

        <section aria-labelledby="items-h" className="card p-4">
          <div className="flex items-center justify-between">
            <h2 id="items-h" className="text-lg font-extrabold">{t('cart.items')}</h2>
            <Link to="/" viewTransition className="text-sm font-bold underline underline-offset-4">{t('cart.addMore')}</Link>
          </div>
          <ul className="mt-2 divide-y divide-line">
            {priced.lines.map(({ line, item, addons, unitPrice, lineTotal, issue, discount, offerTitle }) => (
              <li key={line.key} className="flex gap-3 py-3.5">
                <span className="size-14 shrink-0 overflow-hidden rounded-xl ring-1 ring-line">
                  <FoodImage name={item?.name ?? 'Item'} path={item?.image_path ?? null} className="size-full" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-bold leading-snug">{item?.name ?? t('cart.removed')}</p>
                  {addons.length > 0 && <p className="text-sm text-muted">+ {addons.map((a) => a.name).join(', ')}</p>}
                  {line.note && <p className="text-sm text-muted italic">“{line.note}”</p>}
                  {issue ? (
                    <p className="mt-1 text-sm font-bold text-danger">{t(ISSUE_KEY[issue])}</p>
                  ) : (
                    <p className="tabular mt-0.5 text-sm text-muted">
                      {t('cart.each', { price: money(unitPrice) })}
                      {discount > 0 && offerTitle && <span className="ml-1.5 font-bold text-brand-ink">· {offerTitle}</span>}
                    </p>
                  )}
                  <div className="mt-2 flex items-center justify-between gap-2">
                    {issue ? (
                      <Button size="sm" variant="danger" onClick={() => cart.remove(line.key)}>
                        <IconTrash size={16} /> {t('cart.remove')}
                      </Button>
                    ) : (
                      <QuantityStepper size="sm" value={line.quantity} min={0} onChange={(n) => cart.setQuantity(line.key, n)} label={item?.name ?? 'item'} />
                    )}
                    {!issue && <span className="tabular font-bold">{money(lineTotal)}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <fieldset className="card space-y-3 p-4">
          <legend className="sr-only">{t('cart.when')}</legend>
          <h2 className="text-lg font-extrabold" aria-hidden="true">{t('cart.when')}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <ChoiceCard
              name="when"
              checked={when === 'now'}
              onSelect={() => setWhen('now')}
              title={t('cart.asap')}
              body={data?.eta ? t('cart.asapHint', { minutes: data.eta.minutes }) : ''}
            />
            <ChoiceCard
              name="when"
              checked={when === 'later'}
              onSelect={() => {
                setWhen('later')
                if (!slots.some((s) => s.iso === slot)) setSlot(slots[0]?.iso ?? '')
              }}
              disabled={slots.length === 0}
              title={t('cart.later')}
              body={slots.length ? t('cart.laterHint') : t('cart.laterNone')}
            />
          </div>
          {when === 'later' && slots.length > 0 && (
            <div className="rounded-2xl bg-sunken p-3">
              <label htmlFor="pickup-time" className="label inline-flex items-center gap-1.5"><IconClock size={15} /> {t('cart.pickTime')}</label>
              <select id="pickup-time" className="field-input" value={chosenSlot?.iso ?? ''} onChange={(e) => setSlot(e.target.value)}>
                {!chosenSlot && <option value="" disabled>—</option>}
                {slots.map((s) => (
                  <option key={s.iso} value={s.iso}>{s.label}</option>
                ))}
              </select>
              {slotGone && <p className="mt-2 text-sm font-bold text-danger">{t('cart.timePassed')}</p>}
              {chosenSlot && (
                <p className="mt-2 text-sm text-ink-2">
                  {table ? t('cart.laterTable', { table, time: chosenSlot.label }) : t('cart.laterCounter', { time: chosenSlot.label })}
                </p>
              )}
            </div>
          )}
        </fieldset>

        <section aria-labelledby="details-h" className="card space-y-4 p-4">
          <div>
            <h2 id="details-h" className="text-lg font-extrabold">{t('cart.details')}</h2>
            <p className="text-sm text-muted">
              {table ? t('cart.detailsTable', { table }) : t('cart.detailsCounter')} {t('cart.detailsPrivacy')}
            </p>
          </div>
          <div>
            <label htmlFor={nameId} className="label">{t('cart.name')}</label>
            <input
              id={nameId}
              className="field-input"
              autoComplete="given-name"
              autoCorrect="off"
              spellCheck={false}
              maxLength={40}
              value={name}
              aria-invalid={!!errors.name}
              aria-describedby={errors.name ? `${nameId}-err` : undefined}
              onChange={(e) => {
                setName(e.target.value)
                if (errors.name) setErrors((x) => ({ ...x, name: undefined }))
              }}
              placeholder={t('cart.namePlaceholder')}
            />
            {errors.name && <p id={`${nameId}-err`} className="mt-1.5 text-sm font-semibold text-danger">{t(errors.name)}</p>}
          </div>
          <div>
            <label htmlFor={phoneId} className="label">{t('cart.phone')}</label>
            <div className="flex">
              <span className="inline-flex items-center rounded-l-xl border border-r-0 border-line-strong bg-sunken px-3 font-semibold text-muted">+91</span>
              <input
                id={phoneId}
                className="field-input rounded-l-none"
                type="tel"
                inputMode="numeric"
                autoComplete="tel-national"
                maxLength={16}
                value={phone}
                aria-invalid={!!errors.phone}
                aria-describedby={errors.phone ? `${phoneId}-err` : undefined}
                onChange={(e) => {
                  setPhone(e.target.value.replace(/[^\d\s+]/g, ''))
                  if (errors.phone) setErrors((x) => ({ ...x, phone: undefined }))
                }}
                placeholder="98765 43210"
              />
            </div>
            {errors.phone && <p id={`${phoneId}-err`} className="mt-1.5 text-sm font-semibold text-danger">{t(errors.phone)}</p>}
          </div>
          <div className={`flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm ${table ? 'bg-brand-soft ring-1 ring-brand-strong/40' : 'bg-sunken'}`}>
            <IconPin size={16} className="shrink-0" />
            <span className="flex-1">
              {table ? (
                <><strong>{t('cart.servedTable')}</strong> · {t('order.atTable', { table })}</>
              ) : (
                <><strong>{t('cart.pickupCounter')}</strong> · {t('cart.scanHint')}</>
              )}
            </span>
            {table && (
              <button
                type="button"
                className="font-bold underline underline-offset-4"
                onClick={() => {
                  setCurrentTable(null)
                  setScanned(null)
                }}
              >
                {t('cart.notAt', { table })}
              </button>
            )}
          </div>
        </section>

        <fieldset className="card space-y-3 p-4" aria-describedby={errors.method ? 'method-err' : undefined}>
          <legend className="sr-only">{t('cart.payment')}</legend>
          <h2 className="text-lg font-extrabold" aria-hidden="true">{t('cart.payment')}</h2>
          <ChoiceCard
            id="payment-method"
            name="payment"
            checked={method === 'cash'}
            onSelect={() => {
              setMethod('cash')
              setErrors((x) => ({ ...x, method: undefined }))
            }}
            title={table ? t('cart.cash') : t('cart.cashCounter')}
            body={table ? t('cart.cashTableBody') : t('cart.cashCounterBody')}
          />
          <ChoiceCard
            name="payment"
            checked={method === 'upi'}
            onSelect={() => {
              setMethod('upi')
              setErrors((x) => ({ ...x, method: undefined }))
            }}
            disabled={!upiAvailable}
            title={t('cart.upi')}
            body={upiAvailable ? t('cart.upiBody') : t('cart.upiOff')}
          />
          {errors.method && <p id="method-err" className="text-sm font-semibold text-danger">{t(errors.method)}</p>}
        </fieldset>

        <section className="card p-4" aria-label={t('cart.total')}>
          <div className="flex items-center justify-between text-sm text-muted">
            <span>{priced.units === 1 ? t('menu.item') : t('menu.items', { count: priced.units })}</span>
            <span className="tabular">{money(priced.total + priced.savings)}</span>
          </div>
          {priced.savings > 0 && (
            <div className="mt-1 flex items-center justify-between text-sm font-bold text-ready">
              <span>{t('cart.savings')}</span>
              <span className="tabular">−{money(priced.savings)}</span>
            </div>
          )}
          <div className="mt-2 flex items-center justify-between border-t border-line pt-3">
            <span className="text-lg font-extrabold">{t('cart.total')}</span>
            <span className="tabular text-2xl font-extrabold">{money(priced.total)}</span>
          </div>
          <p className="mt-1 text-xs text-muted">{t('cart.noTax')}</p>
        </section>

        {notice && <Banner tone="warning">{notice}</Banner>}
        {submitError && <Banner tone="danger">{submitError}</Banner>}
        {priced.hasIssues && <Banner tone="danger">{t('cart.removeSoldOut')}</Banner>}

        <div className="sticky bottom-0 -mx-4 bg-canvas/95 px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur">
          <Button type="submit" size="lg" className="w-full" loading={submitting} disabled={!isOpen || priced.hasIssues || priced.units === 0}>
            {submitting ? t('cart.placing') : t('cart.place', { total: money(priced.total) })}
          </Button>
          {chosenSlot && <p className="mt-1.5 text-center text-xs font-bold text-muted">{t('cart.preorderFor', { time: slotLabel(chosenSlot.iso) })}</p>}
        </div>
      </form>
    </div>
  )
}

function ChoiceCard({
  id, name, checked, onSelect, title, body, disabled,
}: { id?: string; name: string; checked: boolean; onSelect: () => void; title: string; body: string; disabled?: boolean }) {
  return (
    <label
      className={`flex items-start gap-3 rounded-2xl border-2 p-3.5 transition-colors ${
        checked ? 'border-ink bg-brand-soft' : 'border-line hover:border-line-strong'
      } ${disabled ? 'cursor-not-allowed opacity-55' : ''}`}
    >
      <input id={id} type="radio" name={name} className="mt-1 size-5 accent-ink" checked={checked} onChange={onSelect} disabled={disabled} />
      <span>
        <span className="block font-bold">{title}</span>
        {body && <span className="block text-sm text-muted">{body}</span>}
      </span>
    </label>
  )
}
