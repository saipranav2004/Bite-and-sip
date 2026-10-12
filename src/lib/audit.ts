// Turns raw audit entries into plain sentences and before → after rows.
import { formatDay, money } from './format'
import { expenseLabel } from './pnl'
import type { AuditEntry } from './types'

export type AuditCategory = 'menu' | 'orders' | 'stock' | 'money' | 'team'

export const AUDIT_CATEGORIES: { value: AuditCategory; label: string }[] = [
  { value: 'menu', label: 'Menu & prices' },
  { value: 'orders', label: 'Orders & payments' },
  { value: 'stock', label: 'Stock' },
  { value: 'money', label: 'Expenses' },
  { value: 'team', label: 'Team & settings' },
]

export function categoryOf(e: AuditEntry): AuditCategory {
  switch (e.entity) {
    case 'menu_item':
    case 'addon':
    case 'category':
    case 'cost':
    case 'recipe':
    case 'offer':
      return 'menu'
    case 'ingredient':
      return 'stock'
    case 'order':
      return 'orders'
    case 'stock':
      return 'stock'
    case 'expense':
    case 'day':
      return 'money'
    default:
      return 'team'
  }
}

/** Changes worth a second look: where money goes, who has access, and reversals. */
export function isSensitive(e: AuditEntry): boolean {
  if (e.entity === 'staff') return true
  if (e.action === 'order.marked_unpaid' || e.action === 'expense.deleted' || e.action === 'day.reclosed') return true
  if (e.action.startsWith('kitchen.')) return true
  if (e.entity === 'settings' && ('upi_id' in e.changes || 'upi_payee_name' in e.changes)) return true
  return false
}

export interface FieldChange {
  field: string
  label: string
  before: string
  after: string
  mono?: boolean
}

const FIELD_LABEL: Record<string, string> = {
  name: 'Name', description: 'Description', price: 'Price', cost: 'Cost', category_id: 'Category', is_veg: 'Vegetarian',
  is_available: 'Availability', is_popular: 'Popular', image_path: 'Photo', menu_item_id: 'Item',
  upi_id: 'UPI ID', upi_payee_name: 'UPI payee name', is_open: 'Taking orders', closed_message: 'Closed message', cafe_name: 'Café name',
  role: 'Role', is_active: 'Access', display_name: 'Name', user_id: 'User',
  payment_status: 'Payment', payment_reference: 'Reference', status: 'Status', cancel_reason: 'Reason',
  title: 'Name', percent_off: 'Discount', menu_item_ids: 'Items', days: 'Days', starts_at: 'From', ends_at: 'Until', valid_from: 'Starts on',
  valid_to: 'Ends on', counted_cash: 'Counted cash', difference: 'Difference',
  on_hand: 'On hand', low_at: 'Low-stock level', quantity: 'Quantity', display_unit: 'Unit', note: 'Note', amount: 'Amount', spent_on: 'Date', category: 'Category', label: 'Table',
}

const HIDDEN = new Set(['id', 'menu_item_id', 'user_id'])

export function formatValue(field: string, v: unknown, ctx: AuditContext, entity = ''): string {
  if (v === null || v === undefined || v === '') return '—'
  switch (field) {
    case 'price':
    case 'cost':
    case 'amount':
    case 'counted_cash':
    case 'difference':
      return money(Number(v))
    case 'percent_off':
      return `${v}%`
    case 'menu_item_ids':
      return Array.isArray(v) ? (v.length ? `${v.length} item(s)` : 'Whole menu') : String(v)
    case 'days':
      return Array.isArray(v) ? (v.length ? v.map((d) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][Number(d) - 1]).join(', ') : 'Every day') : String(v)
    case 'starts_at':
    case 'ends_at':
      return String(v).slice(0, 5)
    case 'valid_from':
    case 'valid_to':
      return formatDay(String(v))
    case 'is_available':
      return v ? (entity === 'table' ? 'Active' : 'Available') : entity === 'table' ? 'Inactive' : 'Sold out'
    case 'is_active':
      if (entity === 'offer') return v ? 'On' : 'Paused'
      return v ? (entity === 'table' ? 'Active' : 'Can sign in') : entity === 'table' ? 'Inactive' : 'Access removed'
    case 'is_open':
      return v ? 'Open' : 'Closed'
    case 'is_veg':
    case 'is_popular':
      return v ? 'Yes' : 'No'
    case 'role':
      return v === 'owner' ? 'Owner' : v === 'kitchen' ? 'Kitchen' : String(v)
    case 'category_id':
      return ctx.categoryName(String(v)) ?? 'Another category'
    case 'category':
      return expenseLabel(String(v))
    case 'spent_on':
      return formatDay(String(v))
    case 'image_path':
      return 'Photo'
    case 'payment_status':
      return v === 'paid' ? 'Paid' : 'Unpaid'
    case 'status':
      return String(v).charAt(0).toUpperCase() + String(v).slice(1)
    default:
      return String(v)
  }
}

export interface AuditContext {
  categoryName(id: string): string | null
}

export function fieldChanges(e: AuditEntry, ctx: AuditContext): FieldChange[] {
  return Object.entries(e.changes)
    .filter(([f]) => !HIDDEN.has(f))
    .map(([field, [before, after]]) => ({
      field,
      label: e.entity === 'offer' && field === 'is_active' ? 'Status' : (FIELD_LABEL[field] ?? field.replaceAll('_', ' ')),
      before: formatValue(field, before, ctx, e.entity),
      after: formatValue(field, after, ctx, e.entity),
      mono: field === 'upi_id' || field === 'payment_reference',
    }))
}

/** One line such as “Price ₹35 → ₹40” or “Price, Description”. */
export function summary(e: AuditEntry, ctx: AuditContext): string {
  const rows = fieldChanges(e, ctx)
  if (e.action.endsWith('.created') || e.action === 'stock.tracking_on' || e.action === 'cost.set') {
    const main = rows.find((r) => ['price', 'cost', 'amount', 'on_hand', 'role'].includes(r.field))
    return main ? `${main.label}: ${main.after}` : ''
  }
  if (e.action.endsWith('.deleted') || e.action === 'stock.tracking_off' || e.action === 'cost.removed') {
    const main = rows.find((r) => ['price', 'cost', 'amount', 'on_hand'].includes(r.field))
    return main ? `Was ${main.before}` : ''
  }
  if (rows.length === 0) return ''
  if (rows.length === 1 || rows.length === 2) return rows.map((r) => (r.field === 'image_path' ? 'New photo' : `${r.label} ${r.before} → ${r.after}`)).join(' · ')
  return `${rows.map((r) => r.label).join(', ')} changed`
}

/** “marked Paneer Wrap sold out”, “reset the password for Ravi”… (the actor is shown separately). */
export function describe(e: AuditEntry): string {
  const what = e.label ?? ''
  const only = Object.keys(e.changes)
  const availability = only.length === 1 && only[0] === 'is_available'
  const nowAvailable = availability && e.changes.is_available?.[1] === true
  switch (e.action) {
    case 'menu_item.created': return `added ${what} to the menu`
    case 'menu_item.deleted': return `deleted ${what} from the menu`
    case 'menu_item.updated':
      if (availability) return nowAvailable ? `marked ${what} available` : `marked ${what} sold out`
      if (only.length === 1 && only[0] === 'price') return `changed the price of ${what}`
      return `edited ${what}`
    case 'addon.created': return `added add-on ${what}`
    case 'addon.deleted': return `removed add-on ${what}`
    case 'addon.updated': return availability ? (nowAvailable ? `marked add-on ${what} available` : `marked add-on ${what} sold out`) : `edited add-on ${what}`
    case 'category.created': return `added category ${what}`
    case 'category.updated': return `renamed category ${what}`
    case 'category.deleted': return `deleted category ${what}`
    case 'cost.set': return `set the cost of ${what}`
    case 'cost.changed': return `changed the cost of ${what}`
    case 'cost.removed': return `removed the cost of ${what}`
    case 'settings.updated':
      if ('upi_id' in e.changes) return 'changed the UPI ID'
      if (only.length === 1 && only[0] === 'is_open') return e.changes.is_open?.[1] ? 'opened the café for orders' : 'closed the café for orders'
      return 'changed café settings'
    case 'table.created': return `added table ${what}`
    case 'table.updated': return `changed table ${what}`
    case 'table.deleted': return `removed table ${what}`
    case 'staff.created': return `added ${what} to the team`
    case 'staff.updated':
      if (only.length === 1 && only[0] === 'is_active') return e.changes.is_active?.[1] ? `restored access for ${what}` : `removed access for ${what}`
      if (only.length === 1 && only[0] === 'role') return `changed the role of ${what}`
      return `updated ${what}`
    case 'staff.deleted': return `deleted ${what} from the team`
    case 'staff.password_reset': return `reset the password for ${what}`
    case 'order.marked_paid': return `confirmed payment for ${what}`
    case 'order.marked_unpaid': return `reversed the payment for ${what}`
    case 'order.cancelled': return `cancelled ${what}`
    case 'stock.restock': return `received stock of ${what}`
    case 'stock.waste': return `wrote off ${what}`
    case 'stock.count': return `recounted ${what}`
    case 'stock.correction': return `corrected the stock of ${what}`
    case 'stock.tracking_on': return `started tracking stock of ${what}`
    case 'stock.tracking_off': return `stopped tracking stock of ${what}`
    case 'stock.low_level_changed': return `changed the low-stock level of ${what}`
    case 'ingredient.created': return `added raw material ${what}`
    case 'ingredient.updated': return `edited raw material ${what}`
    case 'ingredient.archived': return `removed raw material ${what}`
    case 'ingredient.purchase': return `bought ${what}`
    case 'ingredient.usage': return `recorded usage of ${what}`
    case 'ingredient.waste': return `wrote off ${what}`
    case 'ingredient.count': return `counted ${what}`
    case 'ingredient.correction': return `corrected the stock of ${what}`
    case 'recipe.added': return `added ${what.split(' › ')[1] ?? what} to the recipe of ${what.split(' › ')[0]}`
    case 'recipe.changed': return `changed the recipe of ${what.split(' › ')[0]} (${what.split(' › ')[1] ?? ''})`
    case 'recipe.removed': return `removed ${what.split(' › ')[1] ?? what} from the recipe of ${what.split(' › ')[0]}`
    case 'offer.created': return `created the offer ${what}`
    case 'offer.updated':
      if (only.length === 1 && only[0] === 'is_active') return e.changes.is_active?.[1] ? `turned on the offer ${what}` : `paused the offer ${what}`
      return `edited the offer ${what}`
    case 'offer.deleted': return `deleted the offer ${what}`
    case 'day.closed': return `closed the day (${what})`
    case 'day.reclosed': return `changed the closing for ${what}`
    case 'kitchen.link_created': return 'made a new kitchen screen link'
    case 'kitchen.link_disabled': return 'turned off the kitchen screen'
    case 'expense.created': return `logged an expense (${expenseLabel(what)})`
    case 'expense.updated': return `edited an expense (${expenseLabel(what)})`
    case 'expense.deleted': return `deleted an expense (${expenseLabel(what)})`
    default: return `${e.action.replace('.', ' ')} ${what}`.trim()
  }
}
