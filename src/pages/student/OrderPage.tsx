import { useEffect, useRef, useState } from 'react'
import { CheckBurst, Confetti } from '../../components/Celebrate'
import { Link, useLocation, useParams } from 'react-router-dom'
import { backend } from '../../backend'
import { IconBell, IconCheck, IconCopy, IconExternal, IconRefresh, IconStar, IconWifiOff } from '../../components/icons'
import { QrImage } from '../../components/QrImage'
import { DemoRibbon, StudentHeader } from '../../components/StudentShell'
import { Banner, Button, Dialog, EmptyState, PaymentBadge, Spinner, useToast } from '../../components/ui'
import { useOrderTracking } from '../../hooks/useOrderTracking'
import { useT } from '../../i18n'
import { paymentBadge, statusText, stepsFor } from '../../i18n/order'
import { money, orderCode, timeOfDay } from '../../lib/format'
import { canCustomerCancel, paymentDisplay } from '../../lib/orderRules'
import { currentSubscription, isIos, isStandalone, permission, pushSupported, subscribe } from '../../lib/push'
import { slotLabel } from '../../lib/schedule'
import { readJson, writeJson } from '../../lib/storage'
import type { CustomerOrder } from '../../lib/types'
import { buildUpiLink } from '../../lib/upi'
import { tokenFor } from '../../state/device'
import { usePublicData } from '../../state/publicData'
import { useReorder } from './useReorder'

export function OrderPage() {
  const { id = '' } = useParams()
  const location = useLocation()
  const { t, tError } = useT()
  const justPlaced = (location.state as { justPlaced?: boolean } | null)?.justPlaced
  const token = tokenFor(id)
  const { order, setOrder, error, live, lastSync, refetch } = useOrderTracking(id, token)
  const { data } = usePublicData()
  const reorder = useReorder()
  const prevStatus = useRef<string | null>(null)
  // Celebrate a freshly placed order once, and again when it turns ready.
  // (Only for an order placed in the last minute, so a page refresh doesn't replay it.)
  const [celebrate, setCelebrate] = useState(0)
  const freshOrder = !!order && Date.now() - new Date(order.created_at).getTime() < 60_000
  const celebratedPlacement = useRef(false)
  useEffect(() => {
    if (justPlaced && freshOrder && !celebratedPlacement.current) {
      celebratedPlacement.current = true
      setCelebrate((c) => c + 1)
    }
  }, [justPlaced, freshOrder])

  // Nudge the student when the order becomes ready.
  useEffect(() => {
    if (!order) return
    if (prevStatus.current && prevStatus.current !== 'ready' && order.status === 'ready') {
      setCelebrate((c) => c + 1)
      try {
        navigator.vibrate?.([200, 100, 200])
      } catch {
        /* not supported */
      }
    }
    prevStatus.current = order.status
    document.title = order.status === 'ready' ? `${t('order.ready', { code: orderCode(order.order_no) })} · Bite & Sip` : `${orderCode(order.order_no)} · Bite & Sip`
    return () => {
      document.title = 'Bite & Sip'
    }
  }, [order, t])

  if (!token || error === 'order_not_found') {
    return (
      <>
        <DemoRibbon />
        <StudentHeader back="/" title={t('header.orderPlain')} />
        <EmptyState title={t('order.notOnPhone')} action={<Link to="/" className="font-bold underline underline-offset-4">{t('order.backToMenu')}</Link>}>
          {t('order.notOnPhoneBody')}
        </EmptyState>
      </>
    )
  }

  if (!order) {
    return (
      <>
        <DemoRibbon />
        <StudentHeader back="/" title={t('header.orderPlain')} />
        <div className="grid place-items-center gap-4 py-24">
          {error ? (
            <EmptyState icon={<IconWifiOff />} title={t('order.loadFailed')} action={<Button onClick={() => void refetch()}>{t('menu.tryAgain')}</Button>}>
              {tError(new Error(error))}
            </EmptyState>
          ) : (
            <Spinner label={t('order.loading')} />
          )}
        </div>
      </>
    )
  }

  const msg = statusText(t, order)
  const code = orderCode(order.order_no)
  const open = order.status === 'placed' || order.status === 'preparing'
  const eta = data?.eta

  return (
    <div className="min-h-dvh pb-12">
      <DemoRibbon />
      <StudentHeader back="/" title={t('header.order', { code })} />
      <main className="mx-auto max-w-3xl space-y-4 px-4 pt-4">
        {justPlaced && freshOrder && order.status === 'placed' && (
          <Banner tone="success" title={t('order.placedTitle')}>
            {t('order.placedBody')}
          </Banner>
        )}

        <div className="relative">
          {celebrate > 0 && <Confetti key={`c${celebrate}`} count={order.status === 'ready' ? 34 : 26} />}
          <section
            key={`hero-${order.status === 'ready' ? 'ready' : 'base'}`}
            className={`card overflow-hidden transition-colors duration-500 ${order.status === 'ready' ? 'animate-pop border-ink bg-brand' : ''}`}
            aria-live="polite"
            aria-atomic="true"
          >
            <div className="px-5 pt-5 pb-4 text-center">
              {justPlaced && freshOrder && order.status === 'placed' && <CheckBurst className="mx-auto mb-2 size-14" />}
              <p className="text-sm font-bold tracking-wider text-ink-2 uppercase">{t('order.number')}</p>
              <p className="tabular mt-1 text-5xl font-extrabold tracking-tight">{code}</p>
              <p className="mt-1 text-sm font-semibold text-ink-2">
                {order.customer_name} · {order.table_label ? t('order.atTable', { table: order.table_label }) : t('order.atCounter')}
              </p>
              {order.scheduled_for && order.status !== 'cancelled' && order.status !== 'completed' && (
                <p className="mt-2 inline-flex rounded-full bg-ink px-3 py-1 text-sm font-bold text-brand">
                  {t('order.preorder', { time: slotLabel(order.scheduled_for) })}
                </p>
              )}
              <h2 className={`mt-4 text-2xl font-extrabold ${order.status === 'cancelled' ? 'text-danger' : ''}`}>{msg.title}</h2>
              <p className="mt-1 text-[15px] text-ink-2">{msg.body}</p>
              {open && !order.scheduled_for && eta && (
                <p className="mt-1 text-sm text-muted">{t('eta.typical', { minutes: eta.typical_minutes })}</p>
              )}
            </div>
            {order.status !== 'cancelled' && <Steps order={order} />}
          </section>
        </div>

        {open && <NotifyCard order={order} />}

        <PaymentCard order={order} onUpdated={setOrder} />

        {order.status === 'completed' && <FeedbackCard order={order} onUpdated={setOrder} />}

        <section className="card p-4" aria-labelledby="summary-h">
          <div className="flex items-center justify-between gap-3">
            <h2 id="summary-h" className="font-extrabold">{t('order.yourOrder')}</h2>
            {(order.status === 'completed' || order.status === 'cancelled') && (
              <Button size="sm" variant="secondary" onClick={() => reorder(order)}>
                <IconRefresh size={15} /> {t('again.button')}
              </Button>
            )}
          </div>
          <ul className="mt-2 divide-y divide-line">
            {order.items.map((l, i) => (
              <li key={i} className="flex gap-3 py-2.5 text-[15px]">
                <span className="tabular w-7 shrink-0 font-bold">{l.quantity}×</span>
                <span className="min-w-0 flex-1">
                  <span className="font-semibold">{l.name}</span>
                  {l.addons.length > 0 && <span className="block text-sm text-muted">+ {l.addons.map((a) => a.name).join(', ')}</span>}
                  {l.note && <span className="block text-sm text-muted italic">“{l.note}”</span>}
                  {!!l.discount && l.offer_title && (
                    <span className="block text-sm font-bold text-brand-ink">{t('order.offer', { title: l.offer_title, amount: money(l.discount) })}</span>
                  )}
                </span>
                <span className="tabular font-semibold">{money(l.line_total)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center justify-between border-t border-line pt-3">
            <span className="font-extrabold">{t('order.total')}</span>
            <span className="tabular text-xl font-extrabold">{money(order.total)}</span>
          </div>
          <p className="mt-1 text-xs text-muted">{t('order.placedAt', { time: timeOfDay(order.created_at) })}</p>
        </section>

        <CancelSection order={order} onUpdated={setOrder} />

        <LiveIndicator live={live} lastSync={lastSync} onRefresh={() => void refetch()} final={order.status === 'completed' || order.status === 'cancelled'} />
      </main>
    </div>
  )
}

function Steps({ order }: { order: CustomerOrder }) {
  const { t } = useT()
  const steps = stepsFor(t, order.table_label)
  const idx = steps.findIndex((s) => s.status === order.status)
  const times: Record<string, string | null> = {
    placed: order.created_at, preparing: order.preparing_at, ready: order.ready_at, completed: order.completed_at,
  }
  return (
    <ol className="grid grid-cols-4 border-t border-ink/10 bg-surface/60 px-2 py-3">
      {steps.map((s, i) => {
        const done = i <= idx
        const current = i === idx
        return (
          <li key={s.status} className="relative flex flex-col items-center text-center" aria-current={current ? 'step' : undefined}>
            {i > 0 && (
              <span className="absolute top-3.5 right-1/2 h-0.5 w-full bg-line-strong" aria-hidden="true">
                <span className={`block h-full bg-ink transition-[width] duration-700 ease-out ${i <= idx ? 'w-full' : 'w-0'}`} />
              </span>
            )}
            <span
              className={`relative z-10 grid size-7 place-items-center rounded-full border-2 transition-colors duration-500 ${
                done ? 'border-ink bg-ink text-brand' : 'border-line-strong bg-surface text-transparent'
              } ${current && s.status !== 'completed' ? 'animate-pulse-ring' : ''}`}
            >
              <IconCheck size={14} strokeWidth={3.5} />
            </span>
            <span className={`mt-1.5 text-xs font-bold ${done ? 'text-ink' : 'text-subtle'}`}>{s.label}</span>
            <span className="tabular text-[11px] text-muted">{done ? timeOfDay(times[s.status]) : ''}</span>
            <span className="sr-only">{done ? (current ? t('step.current') : t('step.done')) : t('step.upcoming')}</span>
          </li>
        )
      })}
    </ol>
  )
}

const PUSH_ORDERS = 'bitesip-push-orders-v1'

/** "Notify me when it's ready" — a real push notification, even with the screen off. */
function NotifyCard({ order }: { order: CustomerOrder }) {
  const { t, lang } = useT()
  const [key, setKey] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'busy' | 'on' | 'blocked' | 'failed'>('idle')

  useEffect(() => {
    let alive = true
    void backend.pushPublicKey().then(async (k) => {
      if (!alive || !k) return
      setKey(k)
      if (permission() === 'denied') setState('blocked')
      else if (readJson<string[]>(PUSH_ORDERS, []).includes(order.id) && (await currentSubscription())) setState('on')
    })
    return () => {
      alive = false
    }
  }, [order.id])

  if (!key) return null
  const iosHint = !pushSupported() && isIos() && !isStandalone()
  if (!pushSupported() && !iosHint) return null

  async function turnOn() {
    const token = tokenFor(order.id)
    if (!token || !key) return
    setState('busy')
    try {
      const sub = await subscribe(key)
      await backend.subscribeOrderPush(order.id, token, sub, lang)
      writeJson(PUSH_ORDERS, [order.id, ...readJson<string[]>(PUSH_ORDERS, []).filter((x) => x !== order.id)].slice(0, 20))
      setState('on')
    } catch (err) {
      setState(err instanceof Error && err.message === 'blocked' ? 'blocked' : 'failed')
    }
  }

  return (
    <section className={`card flex items-start gap-3 p-4 ${state === 'on' ? 'border-ready/40 bg-ready-soft' : ''}`} aria-live="polite">
      <span className={`grid size-10 shrink-0 place-items-center rounded-full ${state === 'on' ? 'bg-ready text-white' : 'bg-brand text-ink'}`}>
        {state === 'on' ? <IconCheck size={18} strokeWidth={3} /> : <IconBell size={18} />}
      </span>
      <div className="min-w-0 flex-1">
        {state === 'on' ? (
          <p className="pt-2 font-bold">{t('notify.on')}</p>
        ) : (
          <>
            <p className="font-bold">{t('notify.title')}</p>
            <p className="text-sm text-muted">
              {iosHint ? t('notify.ios') : state === 'blocked' ? t('notify.blocked') : state === 'failed' ? t('notify.failed') : t('notify.body')}
            </p>
          </>
        )}
      </div>
      {!iosHint && (state === 'idle' || state === 'busy' || state === 'failed') && (
        <Button size="sm" variant="dark" loading={state === 'busy'} onClick={() => void turnOn()} className="self-center">
          {t('notify.button')}
        </Button>
      )}
    </section>
  )
}

/** Stars and an optional comment, once the order has been served or collected. */
function FeedbackCard({ order, onUpdated }: { order: CustomerOrder; onUpdated: (o: CustomerOrder) => void }) {
  const { t, tError } = useT()
  const toast = useToast()
  const [editing, setEditing] = useState(!order.feedback)
  const [rating, setRating] = useState(order.feedback?.rating ?? 0)
  const [comment, setComment] = useState(order.feedback?.comment ?? '')
  const [busy, setBusy] = useState(false)
  const recent = order.completed_at && Date.now() - Date.parse(order.completed_at) < 3 * 86400000
  if (!recent && !order.feedback) return null

  if (!editing && order.feedback) {
    return (
      <section className="card flex items-center gap-3 p-4">
        <span className="flex text-brand-strong" aria-hidden="true">
          {[1, 2, 3, 4, 5].map((n) => <IconStar key={n} size={18} className={n <= order.feedback!.rating ? '' : 'text-line-strong'} />)}
        </span>
        <p className="flex-1 text-sm font-semibold">{t('feedback.yourRating', { rating: order.feedback.rating })}</p>
        {recent && <button type="button" className="min-h-11 px-2 text-sm font-bold underline underline-offset-4" onClick={() => setEditing(true)}>{t('feedback.edit')}</button>}
      </section>
    )
  }

  async function send() {
    const token = tokenFor(order.id)
    if (!token || rating < 1) return
    setBusy(true)
    try {
      onUpdated(await backend.leaveFeedback(order.id, token, rating, comment.trim() || null))
      toast(t('feedback.thanks'), 'success')
      setEditing(false)
    } catch (err) {
      toast(tError(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card p-4" aria-labelledby="fb-h">
      <h2 id="fb-h" className="font-extrabold">{t('feedback.title')}</h2>
      <p className="text-sm text-muted">{t('feedback.subtitle')}</p>
      <div className="mt-3 flex gap-1" role="radiogroup" aria-label={t('feedback.title')}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={n === 1 ? t('feedback.star', { count: n }) : t('feedback.stars', { count: n })}
            onClick={() => setRating(n)}
            className={`grid size-12 place-items-center rounded-xl transition-transform active:scale-90 ${n <= rating ? 'text-brand-strong' : 'text-line-strong hover:text-brand'}`}
          >
            <IconStar size={32} />
          </button>
        ))}
      </div>
      {rating > 0 ? (
        <>
          <label htmlFor="fb-comment" className="label mt-3">{t('feedback.comment')}</label>
          <textarea
            id="fb-comment"
            className="field-input min-h-20 resize-none"
            maxLength={300}
            value={comment}
            placeholder={t('feedback.placeholder')}
            onChange={(e) => setComment(e.target.value)}
          />
          <Button className="mt-3 w-full" loading={busy} onClick={() => void send()}>{t('feedback.send')}</Button>
        </>
      ) : (
        <p className="mt-1 text-xs text-muted">{t('feedback.pickRating')}</p>
      )}
    </section>
  )
}

function PaymentCard({ order, onUpdated }: { order: CustomerOrder; onUpdated: (o: CustomerOrder) => void }) {
  const { data } = usePublicData()
  const { t, tError } = useT()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [showQr, setShowQr] = useState(false)
  const display = paymentDisplay(order)
  const settings = data?.settings
  const code = orderCode(order.order_no)
  const total = money(order.total)

  if (order.status === 'cancelled') {
    if (order.payment_status !== 'paid' && !order.customer_reported_paid_at) return null
    return (
      <Banner tone="warning" title={t('pay.refundTitle')}>
        {t('pay.refundBody')}
      </Banner>
    )
  }

  const upiLink =
    order.payment_method === 'upi' && settings?.upi_id
      ? buildUpiLink({ upiId: settings.upi_id, payeeName: settings.upi_payee_name, amount: order.total, note: `Bite & Sip ${code}` })
      : null

  async function reportPaid() {
    const token = tokenFor(order.id)
    if (!token) return
    setBusy(true)
    try {
      onUpdated(await backend.reportUpiPayment(order.id, token))
      toast(t('pay.thanks'), 'success')
    } catch (err) {
      toast(tError(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card p-4" aria-labelledby="pay-h">
      <div className="flex items-center justify-between gap-3">
        <h2 id="pay-h" className="font-extrabold">{t('pay.title')}</h2>
        <PaymentBadge display={display} method={order.payment_method} label={paymentBadge(t, order)} />
      </div>

      {display === 'cash_due' && (
        <p className="mt-2 text-[15px]">
          {order.table_label ? t('pay.cashTable', { total, table: order.table_label }) : t('pay.cashCounter', { total })}
        </p>
      )}

      {display === 'paid' && (
        <p className="mt-2 text-[15px]">{order.payment_method === 'cash' ? t('pay.paidCash') : t('pay.paidUpi')}</p>
      )}

      {(display === 'upi_pending' || (display === 'upi_verifying' && showQr)) && (
        <div className="mt-3">
          {upiLink ? (
            <>
              <ol className="space-y-1 text-[15px]">
                <li>{t('pay.step1', { total, payee: settings?.upi_payee_name ?? '' })}</li>
                <li>{t('pay.step2')}</li>
                <li>{t('pay.step3')}</li>
              </ol>
              <a
                href={upiLink}
                className="mt-4 flex min-h-13 w-full items-center justify-center gap-2 rounded-2xl bg-ink px-5 font-extrabold text-white sm:hidden"
              >
                {t('pay.withApp', { total })} <IconExternal size={18} />
              </a>
              <div className="mt-4 flex flex-col items-center gap-2 rounded-2xl border border-line bg-surface p-4">
                <QrImage text={upiLink} size={200} alt={t('pay.qrAlt', { total, payee: settings?.upi_payee_name ?? '' })} />
                <p className="text-center text-sm text-muted">{t('pay.scan')}</p>
                <CopyRow label={t('pay.upiId')} value={settings!.upi_id!} />
              </div>
            </>
          ) : (
            <Banner tone="warning">{t('pay.unavailable')}</Banner>
          )}
          {display === 'upi_pending' && (
            <Button variant="secondary" size="lg" className="mt-4 w-full border-ink" loading={busy} onClick={() => void reportPaid()}>
              {t('pay.iPaid')}
            </Button>
          )}
        </div>
      )}

      {display === 'upi_verifying' && (
        <div className="mt-2 space-y-2 text-[15px]">
          <p>
            <strong>{t('pay.waiting')}</strong> {t('pay.waitingBody')}
          </p>
          <p className="text-sm text-muted">{t('pay.waitingHint')}</p>
          {!showQr && (
            <button type="button" className="text-sm font-bold underline underline-offset-4" onClick={() => setShowQr(true)}>
              {t('pay.showQr')}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const toast = useToast()
  const { t } = useT()
  return (
    <div className="flex w-full items-center gap-2 rounded-xl bg-sunken px-3 py-2 text-sm">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 flex-1 truncate font-bold">{value}</span>
      <button
        type="button"
        className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 font-bold hover:bg-line"
        onClick={() => {
          navigator.clipboard?.writeText(value).then(
            () => toast(t('pay.copied'), 'success'),
            () => toast(t('pay.copyFailed'), 'error'),
          )
        }}
      >
        <IconCopy size={16} /> {t('pay.copy')}
      </button>
    </div>
  )
}

function CancelSection({ order, onUpdated }: { order: CustomerOrder; onUpdated: (o: CustomerOrder) => void }) {
  const toast = useToast()
  const { t, tError } = useT()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!canCustomerCancel(order)) return null

  async function cancel() {
    const token = tokenFor(order.id)
    if (!token) return
    setBusy(true)
    try {
      onUpdated(await backend.cancelMyOrder(order.id, token))
      toast(t('order.cancelled'))
      setConfirm(false)
    } catch (err) {
      toast(tError(err), 'error')
      setConfirm(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="text-center">
        <button type="button" className="min-h-11 px-3 text-sm font-bold text-danger underline underline-offset-4" onClick={() => setConfirm(true)}>
          {t('order.cancelLink')}
        </button>
        <p className="text-xs text-muted">{t('order.cancelHint')}</p>
      </div>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t('order.cancelTitle')}
        size="sm"
        closeLabel={t('help.close')}
        footer={
          <div className="flex gap-3">
            <Button variant="secondary" className="flex-1" onClick={() => setConfirm(false)}>{t('order.keep')}</Button>
            <Button variant="danger" className="flex-1" loading={busy} onClick={() => void cancel()}>{t('order.cancel')}</Button>
          </div>
        }
      >
        <p className="px-5 py-4 text-[15px]">
          {t('order.cancelBody', { code: orderCode(order.order_no), total: money(order.total) })}
        </p>
      </Dialog>
    </>
  )
}

function LiveIndicator({ live, lastSync, onRefresh, final }: { live: string; lastSync: number | null; onRefresh: () => void; final: boolean }) {
  const { t } = useT()
  if (final) return null
  return (
    <div className="flex items-center justify-center gap-2 pt-2 text-sm text-muted">
      <span className={`size-2 rounded-full ${live === 'live' ? 'bg-ready' : 'bg-brand-strong'}`} aria-hidden="true" />
      <span>
        {live === 'live' ? t('order.live') : t('order.reconnecting')}
        {lastSync && ` · ${t('order.updated', { time: timeOfDay(new Date(lastSync).toISOString()) })}`}
      </span>
      <button type="button" onClick={onRefresh} className="grid size-9 place-items-center rounded-full hover:bg-sunken" aria-label={t('order.refresh')}>
        <IconRefresh size={16} />
      </button>
    </div>
  )
}
