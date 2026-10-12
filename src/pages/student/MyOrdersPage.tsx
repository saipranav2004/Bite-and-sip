import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { backend } from '../../backend'
import { IconChevronRight, IconReceipt, IconRefresh } from '../../components/icons'
import { DemoRibbon, StudentHeader } from '../../components/StudentShell'
import { Banner, Button, EmptyState, PaymentBadge, Spinner, StatusBadge } from '../../components/ui'
import { useT } from '../../i18n'
import { paymentBadge, statusBadge } from '../../i18n/order'
import { dateLabel, money, orderCode, timeOfDay } from '../../lib/format'
import { OPEN_STATUSES, paymentDisplay } from '../../lib/orderRules'
import type { CustomerOrder } from '../../lib/types'
import { myOrderRefs } from '../../state/device'
import { useReorder } from './useReorder'

export function MyOrdersPage() {
  const { t, tError } = useT()
  const [orders, setOrders] = useState<CustomerOrder[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setError(null)
    try {
      const refs = myOrderRefs()
      const list = await backend.getOrders(refs.map((r) => ({ id: r.id, token: r.token })))
      setOrders(list.sort((a, b) => b.created_at.localeCompare(a.created_at)))
    } catch (err) {
      setError(tError(err))
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const active = orders?.filter((o) => OPEN_STATUSES.includes(o.status)) ?? []
  const past = orders?.filter((o) => !OPEN_STATUSES.includes(o.status)) ?? []

  return (
    <div className="min-h-dvh pb-12">
      <DemoRibbon />
      <StudentHeader back="/" title={t('orders.title')} right={<span />} />
      <main className="mx-auto max-w-3xl px-4 pt-4">
        {error && (
          <Banner tone="danger" action={<Button size="sm" variant="secondary" onClick={() => void load()}>{t('orders.retry')}</Button>}>
            {error}
          </Banner>
        )}
        {!orders && !error && <div className="grid place-items-center py-20"><Spinner label={t('orders.loading')} /></div>}
        {orders && orders.length === 0 && (
          <EmptyState icon={<IconReceipt />} title={t('orders.none')} action={<Link to="/" viewTransition className="inline-flex min-h-11 items-center rounded-xl bg-brand px-4 font-bold text-ink hover:bg-brand-strong">{t('cart.browse')}</Link>}>
            {t('orders.noneBody')}
          </EmptyState>
        )}
        {active.length > 0 && <OrderList title={t('orders.inProgress')} orders={active} />}
        {past.length > 0 && <OrderList title={t('orders.earlier')} orders={past} again />}
        {orders && orders.length > 0 && <p className="mt-6 text-center text-xs text-muted">{t('orders.footnote')}</p>}
      </main>
    </div>
  )
}

function OrderList({ title, orders, again = false }: { title: string; orders: CustomerOrder[]; again?: boolean }) {
  const { t } = useT()
  const reorder = useReorder()
  return (
    <section className="mt-4">
      <h2 className="text-sm font-extrabold tracking-wider text-muted uppercase">{title}</h2>
      <ul className="mt-2 space-y-2">
        {orders.map((o, i) => (
          <li key={o.id} className="card animate-rise overflow-hidden" style={{ animationDelay: `${Math.min(i * 60, 360)}ms` }}>
            <Link to={`/order/${o.id}`} viewTransition className="flex items-center gap-3 p-4 transition-colors hover:bg-sunken/50">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="tabular font-extrabold">{orderCode(o.order_no)}</span>
                  <StatusBadge status={o.status} label={statusBadge(t, o)} />
                  {o.status !== 'cancelled' && <PaymentBadge display={paymentDisplay(o)} method={o.payment_method} label={paymentBadge(t, o)} />}
                </div>
                <p className="mt-1 truncate text-sm text-muted">{o.items.map((x) => `${x.quantity}× ${x.name}`).join(', ')}</p>
                <p className="mt-0.5 text-xs text-subtle">
                  {dateLabel(o.created_at)}, {timeOfDay(o.created_at)}
                </p>
              </div>
              <span className="tabular font-bold">{money(o.total)}</span>
              <IconChevronRight className="text-subtle" />
            </Link>
            {again && (
              <div className="border-t border-line px-4 py-2">
                <button type="button" className="inline-flex min-h-10 items-center gap-1.5 text-sm font-bold" onClick={() => reorder(o)}>
                  <IconRefresh size={15} /> {t('again.button')}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
