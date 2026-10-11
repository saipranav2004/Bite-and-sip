export type OrderStatus = 'placed' | 'preparing' | 'ready' | 'completed' | 'cancelled'
export type PaymentMethod = 'cash' | 'upi'
export type PaymentStatus = 'unpaid' | 'paid'
export type StaffRole = 'owner' | 'kitchen'

export interface CafeSettings {
  cafe_name: string
  is_open: boolean
  closed_message: string
  upi_id: string | null
  upi_payee_name: string
  updated_at?: string
}

export interface Category {
  id: string
  name: string
  sort_order: number
}

export interface Addon {
  id: string
  menu_item_id: string
  name: string
  price: number
  is_available: boolean
  sort_order: number
}

export interface MenuItem {
  id: string
  category_id: string
  name: string
  description: string
  price: number
  is_veg: boolean
  is_available: boolean
  is_popular: boolean
  image_path: string | null
  sort_order: number
  addons: Addon[]
}

export interface CafeTable {
  label: string
  is_active: boolean
}

export interface Menu {
  categories: Category[]
  items: MenuItem[]
}

export interface OrderLineAddon {
  id: string
  name: string
  price: number
}

export interface OrderLine {
  name: string
  base_price: number
  addons: OrderLineAddon[]
  unit_price: number
  quantity: number
  line_total: number
  note: string | null
}

/** What a student's device can see about its own order. */
export interface CustomerOrder {
  id: string
  order_no: number
  customer_name: string
  phone_last4: string
  table_label: string | null
  status: OrderStatus
  payment_method: PaymentMethod
  payment_status: PaymentStatus
  customer_reported_paid_at: string | null
  total: number
  item_count: number
  cancel_reason: string | null
  cancelled_by: 'customer' | 'staff' | null
  track_key: string
  created_at: string
  updated_at: string
  preparing_at: string | null
  ready_at: string | null
  completed_at: string | null
  cancelled_at: string | null
  paid_at: string | null
  items: OrderLine[]
}

/** What staff see. */
export interface StaffOrder {
  id: string
  order_no: number
  customer_name: string
  customer_phone: string
  table_label: string | null
  status: OrderStatus
  payment_method: PaymentMethod
  payment_status: PaymentStatus
  customer_reported_paid_at: string | null
  payment_reference: string | null
  total: number
  item_count: number
  cancel_reason: string | null
  cancelled_by: 'customer' | 'staff' | null
  created_at: string
  updated_at: string
  preparing_at: string | null
  ready_at: string | null
  completed_at: string | null
  cancelled_at: string | null
  paid_at: string | null
  items: OrderLine[]
}

export interface StaffProfile {
  user_id: string
  email: string | null
  display_name: string
  role: StaffRole
  is_active: boolean
}

export interface StaffMember {
  user_id: string
  display_name: string
  role: StaffRole
  is_active: boolean
  created_at: string
  /** Sign-in address (username@bite.local for short usernames). */
  email: string | null
  last_sign_in_at: string | null
}

/** A stock-tracked menu item. Items without a row are not tracked. */
export interface StockLevel {
  menu_item_id: string
  on_hand: number
  low_at: number
  updated_at: string
}

export type StockMovementKind = 'initial' | 'sale' | 'cancel_return' | 'restock' | 'waste' | 'count' | 'correction'
export type StockAdjustKind = 'restock' | 'waste' | 'count' | 'correction'

export interface StockMovement {
  id: number
  menu_item_id: string | null
  item_name: string
  kind: StockMovementKind
  delta: number
  on_hand_after: number
  unit_cost: number | null
  order_id: string | null
  note: string | null
  actor_name: string | null
  created_at: string
}

/** Owner-only: what each item and add-on costs the café to make. */
export interface Costs {
  items: Record<string, number>
  addons: Record<string, number>
}

export type ExpenseCategory =
  | 'ingredients' | 'salaries' | 'rent' | 'utilities' | 'gas' | 'packaging' | 'maintenance' | 'marketing' | 'other'

export interface Expense {
  id: string
  spent_on: string
  category: ExpenseCategory
  amount: number
  note: string | null
  created_at: string
  updated_at: string
}

export interface ExpenseInput {
  spent_on: string
  category: ExpenseCategory
  amount: number
  note: string | null
}

export interface ProfitAndLossData {
  from: string
  to: string
  orders: number
  sales: number
  outstanding: number
  refunds_due: number
  food_cost: number
  costed_sales: number
  uncosted_sales: number
  uncosted_items: number
  waste_cost: number
  waste_units: number
  waste_uncosted_units: number
  expenses: { category: ExpenseCategory; amount: number; entries: number }[]
  items: { name: string; quantity: number; sales: number; cost: number | null }[]
  by_day: { day: string; sales: number; food_cost: number; expenses: number }[]
}

export interface AuditEntry {
  id: number
  at: string
  actor: string | null
  actor_name: string
  action: string
  entity: string
  entity_id: string | null
  label: string | null
  /** field → [before, after] */
  changes: Record<string, [unknown, unknown]>
}

export interface AuditQuery {
  fromDay: string
  toDay: string
  /** Load entries older than this id (paging). */
  beforeId?: number
  limit?: number
}

export interface SalesSummary {
  from: string
  to: string
  orders: number
  items_sold: number
  sales: number
  average_order_value: number
  cash_collected: number
  upi_confirmed: number
  outstanding_cash: number
  outstanding_upi: number
  upi_awaiting_verification: number
  open_orders: number
  completed_orders: number
  cancelled_orders: number
  cancelled_value: number
  refunds_due: number
  refunds_due_count: number
  top_items: { name: string; quantity: number; sales: number }[]
  by_day: { day: string; orders: number; sales: number }[]
  by_hour: { hour: number; orders: number; sales: number }[]
}

/** One line of the student's cart, stored on the device. */
export interface CartLine {
  key: string
  menu_item_id: string
  addon_ids: string[]
  quantity: number
  note: string
}

export interface PlaceOrderInput {
  client_request_id: string
  access_token: string
  customer_name: string
  customer_phone: string
  payment_method: PaymentMethod
  table_label: string | null
  items: { menu_item_id: string; quantity: number; addon_ids: string[]; note: string | null }[]
}
