import type { OrderStatus, PaymentMethod, PaymentStatus, StaffRole } from './types'

/** Allowed status transitions. Mirrors private.orders_guard() in the database. */
export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  placed: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
}

export const OPEN_STATUSES: OrderStatus[] = ['placed', 'preparing', 'ready']

export function canTransition(from: OrderStatus, to: OrderStatus) {
  return TRANSITIONS[from].includes(to)
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  placed: 'New',
  preparing: 'Preparing',
  ready: 'Ready',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

/** Student-facing wording. */
export const STATUS_MESSAGE: Record<OrderStatus, { title: string; body: string }> = {
  placed: { title: 'Order received', body: 'The kitchen will start on it shortly.' },
  preparing: { title: 'Being prepared', body: 'Your food is being made fresh.' },
  ready: { title: 'Ready for pickup', body: 'Collect it at the counter. Show your order number.' },
  completed: { title: 'Collected', body: 'Enjoy your food!' },
  cancelled: { title: 'Order cancelled', body: '' },
}

export const STUDENT_STEPS: { status: OrderStatus; label: string }[] = [
  { status: 'placed', label: 'Received' },
  { status: 'preparing', label: 'Preparing' },
  { status: 'ready', label: 'Ready' },
  { status: 'completed', label: 'Collected' },
]

/**
 * Orders from a table QR are brought to the table; everything else is
 * collected at the counter. The table on the order decides which.
 */
export function statusMessage(status: OrderStatus, table: string | null): { title: string; body: string } {
  if (!table) return STATUS_MESSAGE[status]
  if (status === 'ready') return { title: 'Ready — on its way', body: `We’re bringing it to Table ${table}.` }
  if (status === 'completed') return { title: 'Served', body: 'Enjoy your food!' }
  if (status === 'placed') return { title: 'Order received', body: `We’ll bring it to Table ${table} when it’s ready.` }
  return STATUS_MESSAGE[status]
}

export function studentSteps(table: string | null) {
  return table ? STUDENT_STEPS.map((s) => (s.status === 'completed' ? { ...s, label: 'Served' } : s)) : STUDENT_STEPS
}

export type PaymentDisplay = 'cash_due' | 'upi_pending' | 'upi_verifying' | 'paid'

/**
 * Payment status stays "unpaid" until staff confirm. The extra UPI step only
 * records that the student *says* they paid — it never counts as payment.
 */
export function paymentDisplay(o: {
  payment_method: PaymentMethod
  payment_status: PaymentStatus
  customer_reported_paid_at: string | null
}): PaymentDisplay {
  if (o.payment_status === 'paid') return 'paid'
  if (o.payment_method === 'cash') return 'cash_due'
  return o.customer_reported_paid_at ? 'upi_verifying' : 'upi_pending'
}

export const PAYMENT_LABEL: Record<PaymentDisplay, string> = {
  cash_due: 'Cash · not paid yet',
  upi_pending: 'UPI · not paid yet',
  upi_verifying: 'UPI · check payment',
  paid: 'Paid',
}

export function canCustomerCancel(o: {
  status: OrderStatus
  payment_status: PaymentStatus
  customer_reported_paid_at: string | null
}) {
  return o.status === 'placed' && o.payment_status === 'unpaid' && !o.customer_reported_paid_at
}

export function canRevertPayment(role: StaffRole, o: { status: OrderStatus; payment_status: PaymentStatus }) {
  return role === 'owner' && o.payment_status === 'paid' && o.status !== 'completed' && o.status !== 'cancelled'
}

export function canMarkPaid(o: { status: OrderStatus; payment_status: PaymentStatus }) {
  return o.payment_status === 'unpaid' && o.status !== 'cancelled' && o.status !== 'completed'
}
