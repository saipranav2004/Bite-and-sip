// Order wording for students, in their language.
import { slotLabel } from '../lib/schedule'
import { paymentDisplay } from '../lib/orderRules'
import type { CustomerOrder, OrderStatus } from '../lib/types'
import type { MessageKey, Translate } from './index'

export function statusText(t: Translate, o: Pick<CustomerOrder, 'status' | 'table_label' | 'scheduled_for' | 'cancelled_by' | 'cancel_reason'>) {
  const table = o.table_label
  switch (o.status) {
    case 'placed':
      if (o.scheduled_for) return { title: t('status.scheduled.title'), body: t('status.scheduled.body', { time: slotLabel(o.scheduled_for) }) }
      return { title: t('status.placed.title'), body: table ? t('status.placed.bodyTable', { table }) : t('status.placed.body') }
    case 'preparing':
      return { title: t('status.preparing.title'), body: t('status.preparing.body') }
    case 'ready':
      return table
        ? { title: t('status.ready.titleTable'), body: t('status.ready.bodyTable', { table }) }
        : { title: t('status.ready.title'), body: t('status.ready.body') }
    case 'completed':
      return { title: t(table ? 'status.completed.titleTable' : 'status.completed.title'), body: t('status.completed.body') }
    case 'cancelled':
      return {
        title: t('status.cancelled.title'),
        body: o.cancelled_by === 'customer'
          ? t('order.youCancelled')
          : o.cancel_reason ? t('order.cafeCancelledReason', { reason: o.cancel_reason }) : t('order.cafeCancelled'),
      }
  }
}

export function stepsFor(t: Translate, table: string | null): { status: OrderStatus; label: string }[] {
  return [
    { status: 'placed', label: t('step.placed') },
    { status: 'preparing', label: t('step.preparing') },
    { status: 'ready', label: t('step.ready') },
    { status: 'completed', label: t(table ? 'step.served' : 'step.collected') },
  ]
}

const STATUS_BADGE: Record<OrderStatus, MessageKey> = {
  placed: 'badge.new', preparing: 'badge.preparing', ready: 'badge.ready', completed: 'badge.collected', cancelled: 'badge.cancelled',
}

export function statusBadge(t: Translate, o: Pick<CustomerOrder, 'status' | 'table_label'>) {
  return o.status === 'completed' && o.table_label ? t('badge.served') : t(STATUS_BADGE[o.status])
}

export function paymentBadge(t: Translate, o: Parameters<typeof paymentDisplay>[0]) {
  const d = paymentDisplay(o)
  if (d === 'paid') return t(o.payment_method === 'cash' ? 'badge.paidCash' : 'badge.paidUpi')
  return t(d === 'cash_due' ? 'badge.cashDue' : d === 'upi_pending' ? 'badge.upiDue' : 'badge.upiChecking')
}
