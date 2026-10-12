// Demo backend: runs entirely in this browser (localStorage + BroadcastChannel).
// It powers the interactive mockups, UI tests and previews when no Supabase
// project is configured. It mirrors the database rules (pricing, state machine,
// stock, permissions, audit log) but is NOT secure: nothing here should be used
// for real orders.
import catalog from '../data/catalog.json'
import { AppError } from '../lib/errors'
import { addDays, cafeDate, cafeDayStartIso } from '../lib/format'
import { canTransition, OPEN_STATUSES } from '../lib/orderRules'
import { computeProfitAndLoss } from '../lib/pnl'
import { MAX_LINES, MAX_QTY_PER_LINE, MAX_UNITS } from '../lib/pricing'
import { summarize } from '../lib/reports'
import { readJson, writeJson } from '../lib/storage'
import type {
  AuditEntry, Ingredient, IngredientMovement, Recipes, CafeSettings, CafeTable, Category, Costs, CustomerOrder, Expense, ExpenseInput, MenuItem, OrderLine,
  PaymentMethod, PlaceOrderInput, StaffMember, StaffOrder, StaffProfile, StaffRole, StockLevel, StockMovement,
} from '../lib/types'
import { cleanText, normalizePhone, normalizeTableLabel } from '../lib/validation'
import { isValidUpiId } from '../lib/upi'
import { bundledImage, isBundledImage } from '../lib/images'
import type { Backend, LiveStatus, MenuItemInput, PublicData } from './types'

const STORE_KEY = 'bitesip-demo-v4'
const SESSION_KEY = 'bitesip-demo-session'

export const DEMO_ACCOUNTS = [
  { email: 'owner@demo.bitesip', password: 'demo-owner', role: 'owner' as const, name: 'Asha (Owner)', user_id: 'demo-owner' },
  { email: 'kitchen@demo.bitesip', password: 'demo-kitchen', role: 'kitchen' as const, name: 'Ravi (Kitchen)', user_id: 'demo-kitchen' },
]

/** Illustrative costs for the demo menu (₹ per unit). Chocolate Shake is left unset on purpose. */
const DEMO_COSTS: Record<string, number> = {
  'Masala Chai': 6, 'Filter Coffee': 8, 'Cold Coffee': 16, 'Fresh Lime Soda': 7, 'Crispy Samosa': 6,
  'Veg Sandwich': 17, 'Paneer Wrap': 28, 'Bread Omelette': 14, 'College Special Maggi': 17, 'Veg Fried Rice': 30,
  'Egg Fried Rice': 34, 'Maggi + Chai Combo': 23, 'Samosa + Chai Combo': 12,
}
const DEMO_ADDON_COSTS: Record<string, number> = { 'Extra Cheese': 7, 'Cheese slice': 6, 'Extra Paneer': 12, 'Ice cream scoop': 9 }

interface DemoOrder extends StaffOrder {
  token: string
  track_key: string
  client_request_id: string
  /** Cost per unit for each line at the moment of sale (null = no cost set). */
  line_costs: (number | null)[]
}

interface DemoAccount {
  email: string
  password: string
  user_id: string
}

interface Store {
  version: 4
  settings: CafeSettings
  categories: Category[]
  items: MenuItem[]
  tables: CafeTable[]
  orders: DemoOrder[]
  staff: StaffMember[]
  accounts: DemoAccount[]
  nextOrderNo: number
  costs: Costs
  stock: StockLevel[]
  movements: StockMovement[]
  expenses: Expense[]
  audit: AuditEntry[]
  nextId: number
  ingredients: Ingredient[]
  ingredientMoves: IngredientMovement[]
  recipes: Recipes
}

const delay = (ms = 120) => new Promise((r) => setTimeout(r, ms))
const now = () => new Date().toISOString()
const uuid = () => crypto.randomUUID()
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

function seedMenu(): { categories: Category[]; items: MenuItem[] } {
  return {
    categories: catalog.categories.map((c) => ({ ...c })),
    items: catalog.items.map((i) => ({
      id: i.id,
      category_id: i.category_id,
      name: i.name,
      description: i.description,
      price: i.price,
      is_veg: i.is_veg,
      is_available: i.is_available,
      is_popular: i.is_popular,
      image_path: i.image_path ?? null,
      sort_order: i.sort_order,
      addons: i.addons.map((a) => ({ ...a, menu_item_id: i.id, is_available: true })),
    })),
  }
}

function seedCosts(items: MenuItem[]): Costs {
  const costs: Costs = { items: {}, addons: {} }
  for (const i of items) {
    if (DEMO_COSTS[i.name] !== undefined) costs.items[i.id] = DEMO_COSTS[i.name]
    for (const a of i.addons) if (DEMO_ADDON_COSTS[a.name] !== undefined) costs.addons[a.id] = DEMO_ADDON_COSTS[a.name]
  }
  return costs
}

/** Deterministic pseudo-random sequence so the sample history is stable. */
function prng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
}

const FIRST_NAMES = ['Nikitha', 'Arjun', 'Priya', 'Rahul', 'Sneha', 'Karthik', 'Divya', 'Vikram', 'Ananya', 'Rohan', 'Meera', 'Aditya']

function buildLine(item: MenuItem, qty: number, addonIds: string[], note: string | null): OrderLine {
  const addons = item.addons.filter((a) => addonIds.includes(a.id)).map((a) => ({ id: a.id, name: a.name, price: a.price }))
  const unit = item.price + addons.reduce((s, a) => s + a.price, 0)
  return { name: item.name, base_price: item.price, addons, unit_price: unit, quantity: qty, line_total: unit * qty, note }
}

function lineCost(costs: Costs, item: MenuItem, addonIds: string[]): number | null {
  const base = costs.items[item.id]
  if (base === undefined) return null
  return base + addonIds.reduce((s, id) => s + (costs.addons[id] ?? 0), 0)
}

/** Sample history: the previous 13 days of completed orders plus a few live ones today. */
function seedOrders(items: MenuItem[], costs: Costs): { orders: DemoOrder[]; next: number } {
  const rand = prng(20261010)
  const available = items.filter((i) => i.is_available)
  const orders: DemoOrder[] = []
  let no = 1001
  const today = cafeDate()
  const nowMs = Date.now()

  const make = (createdAt: Date, status: StaffOrder['status'], method: PaymentMethod, paid: boolean): DemoOrder => {
    const lineCount = 1 + Math.floor(rand() * 3)
    const lines: OrderLine[] = []
    const lineCosts: (number | null)[] = []
    const used = new Set<string>()
    for (let k = 0; k < lineCount; k++) {
      const item = available[Math.floor(rand() * available.length)]
      if (used.has(item.id)) continue
      used.add(item.id)
      const addonIds = item.addons.length && rand() < 0.4 ? [item.addons[0].id] : []
      lines.push(buildLine(item, 1 + Math.floor(rand() * 2), addonIds, null))
      lineCosts.push(lineCost(costs, item, addonIds))
    }
    const total = lines.reduce((s, l) => s + l.line_total, 0)
    const created = createdAt.toISOString()
    const name = FIRST_NAMES[Math.floor(rand() * FIRST_NAMES.length)]
    const phone = `9${Math.floor(100000000 + rand() * 899999999)}`
    const step = (min: number) => new Date(createdAt.getTime() + min * 60000).toISOString()
    const reached = (s: StaffOrder['status']) => ['preparing', 'ready', 'completed'].indexOf(status) >= ['preparing', 'ready', 'completed'].indexOf(s)
    return {
      id: uuid(),
      order_no: no++,
      customer_name: name,
      customer_phone: phone,
      table_label: rand() < 0.75 ? `T${1 + Math.floor(rand() * 12)}` : null,
      status,
      payment_method: method,
      payment_status: paid ? 'paid' : 'unpaid',
      customer_reported_paid_at: null,
      payment_reference: null,
      total,
      item_count: lines.reduce((s, l) => s + l.quantity, 0),
      cancel_reason: status === 'cancelled' ? 'Item ran out' : null,
      cancelled_by: status === 'cancelled' ? 'staff' : null,
      created_at: created,
      updated_at: created,
      preparing_at: status !== 'placed' && status !== 'cancelled' && reached('preparing') ? step(2) : null,
      ready_at: status !== 'placed' && status !== 'cancelled' && reached('ready') ? step(9) : null,
      completed_at: status === 'completed' ? step(14) : null,
      cancelled_at: status === 'cancelled' ? step(3) : null,
      paid_at: paid ? step(14) : null,
      items: lines,
      line_costs: lineCosts,
      token: uuid().replaceAll('-', '') + uuid().replaceAll('-', ''),
      track_key: uuid(),
      client_request_id: uuid(),
    }
  }

  for (let d = 13; d >= 1; d--) {
    const day = addDays(today, -d)
    const count = 18 + Math.floor(rand() * 14)
    for (let k = 0; k < count; k++) {
      const minutes = 8 * 60 + Math.floor(rand() * 10 * 60) // 8am–6pm IST
      const created = new Date(new Date(cafeDayStartIso(day)).getTime() + minutes * 60000)
      const cancelled = rand() < 0.04
      const method: PaymentMethod = rand() < 0.55 ? 'upi' : 'cash'
      orders.push(make(created, cancelled ? 'cancelled' : 'completed', method, !cancelled))
    }
  }

  // Today: a few finished orders, and some live ones a few minutes old.
  const todayStart = new Date(cafeDayStartIso(today)).getTime()
  const earliest = Math.min(nowMs - 30 * 60000, todayStart + 9 * 3600000)
  for (let k = 0; k < 6; k++) {
    const t = Math.min(nowMs - 25 * 60000, earliest + k * 11 * 60000)
    orders.push(make(new Date(Math.max(todayStart, t)), 'completed', k % 2 ? 'upi' : 'cash', true))
  }
  const live: [number, StaffOrder['status'], PaymentMethod, boolean][] = [
    [14, 'ready', 'cash', false],
    [9, 'preparing', 'upi', true],
    [6, 'preparing', 'cash', false],
    [3, 'placed', 'upi', false],
    [1, 'placed', 'cash', false],
  ]
  for (const [minsAgo, status, method, paid] of live) {
    const o = make(new Date(Math.max(todayStart, nowMs - minsAgo * 60000)), status, method, paid)
    if (method === 'upi' && !paid) o.customer_reported_paid_at = new Date(nowMs - 2 * 60000).toISOString()
    orders.push(o)
  }
  return { orders, next: no }
}

/** Sample stock, expenses and audit history so every owner screen has something to show. */
function seedBusiness(items: MenuItem[], costs: Costs) {
  const rand = prng(1010)
  const today = cafeDate()
  const at = (day: string, hour: number) => new Date(new Date(cafeDayStartIso(day)).getTime() + hour * 3600000).toISOString()
  const byName = (n: string) => items.find((i) => i.name === n)!
  let id = 1
  const samosa = byName('Crispy Samosa')
  const sandwich = byName('Veg Sandwich')
  const stock: StockLevel[] = [
    { menu_item_id: samosa.id, on_hand: 24, low_at: 10, updated_at: at(today, 8) },
    { menu_item_id: sandwich.id, on_hand: 4, low_at: 5, updated_at: at(today, 8.5) },
  ]
  const movements: StockMovement[] = []
  const move = (item: MenuItem, kind: StockMovement['kind'], delta: number, after: number, created: string, actor: string, note: string | null = null) =>
    movements.push({
      id: id++, menu_item_id: item.id, item_name: item.name, kind, delta, on_hand_after: after,
      unit_cost: kind === 'waste' ? costs.items[item.id] ?? null : null, order_id: null, note, actor_name: actor, created_at: created,
    })
  move(samosa, 'initial', 30, 30, at(addDays(today, -6), 8), 'Asha (Owner)')
  move(sandwich, 'initial', 12, 12, at(addDays(today, -6), 8), 'Asha (Owner)')
  for (let d = 5; d >= 0; d--) {
    const day = addDays(today, -d)
    move(samosa, 'restock', 40, 40 + Math.floor(rand() * 6), at(day, 8), 'Ravi (Kitchen)', 'Morning batch')
    if (d % 2 === 1) move(samosa, 'waste', -3, 2, at(day, 18), 'Ravi (Kitchen)', 'Unsold at closing')
    move(sandwich, 'restock', 12, 12, at(day, 8.5), 'Ravi (Kitchen)', 'Bread delivery')
  }
  move(sandwich, 'count', -1, 4, at(today, 11), 'Ravi (Kitchen)', 'Recount at lunch')

  const expenses: Expense[] = []
  const spend = (day: string, category: Expense['category'], amount: number, note: string | null) =>
    expenses.push({ id: uuid(), spent_on: day, category, amount, note, created_at: at(day, 19), updated_at: at(day, 19) })
  for (let d = 13; d >= 0; d--) {
    const day = addDays(today, -d)
    spend(day, 'ingredients', 650 + Math.round(rand() * 5) * 50, 'Milk, vegetables, bread')
    if (d % 6 === 1) spend(day, 'gas', 1050, 'LPG cylinder')
    if (d % 4 === 2) spend(day, 'packaging', 150 + Math.round(rand() * 3) * 50, 'Cups and plates')
    if (d % 7 === 0) spend(day, 'salaries', 2100, 'Weekly wages · 1 helper')
  }
  spend(addDays(today, -10), 'rent', 2500, 'Counter rent (half month)')
  spend(addDays(today, -9), 'utilities', 900, 'Electricity')
  spend(addDays(today, -4), 'maintenance', 350, 'Mixer repair')

  const audit: AuditEntry[] = []
  const log = (day: string, hour: number, actor: string, action: string, entity: string, label: string, changes: AuditEntry['changes'], entityId: string | null = null) =>
    audit.push({ id: id++, at: at(day, hour), actor: null, actor_name: actor, action, entity, entity_id: entityId, label, changes })
  const coldCoffee = byName('Cold Coffee')
  log(addDays(today, -6), 8, 'Asha (Owner)', 'stock.tracking_on', 'stock', samosa.name, { on_hand: [null, 30], low_at: [null, 10] }, samosa.id)
  log(addDays(today, -5), 10.5, 'Asha (Owner)', 'menu_item.updated', 'menu_item', coldCoffee.name, { price: [35, coldCoffee.price] }, coldCoffee.id)
  log(addDays(today, -5), 10.6, 'Asha (Owner)', 'cost.changed', 'cost', coldCoffee.name, { cost: [14, 16] }, coldCoffee.id)
  log(addDays(today, -3), 13, 'Ravi (Kitchen)', 'menu_item.updated', 'menu_item', 'Paneer Wrap', { is_available: [true, false] }, byName('Paneer Wrap').id)
  log(addDays(today, -2), 9, 'Asha (Owner)', 'settings.updated', 'settings', 'Café settings', { upi_id: [null, catalog.settings.upi_id] }, 'true')
  log(addDays(today, -1), 12.2, 'Ravi (Kitchen)', 'order.cancelled', 'order', 'Order BS-1290 · ₹55 CASH', { status: ['preparing', 'cancelled'], cancel_reason: [null, 'Item ran out'] })
  log(today, 9.1, 'Ravi (Kitchen)', 'order.marked_paid', 'order', 'Order BS-1371 · ₹70 UPI', { payment_status: ['unpaid', 'paid'], payment_reference: [null, 'UTR 4521'] })
  audit.sort((a, b) => a.at.localeCompare(b.at))
  audit.forEach((a, i) => (a.id = i + 1))
  return { stock, movements, expenses, audit, nextId: Math.max(audit.length, ...movements.map((m) => m.id)) + 1 }
}

/** Sample raw materials and recipes (quantities in g / ml / pieces / packets). */
function seedIngredients(items: MenuItem[], nextId: number) {
  const today = cafeDate()
  const at = (day: string, hour: number) => new Date(new Date(cafeDayStartIso(day)).getTime() + hour * 3600000).toISOString()
  const list: [string, Ingredient['base_unit'], Ingredient['display_unit'], number, number, number][] = [
    ['Milk', 'ml', 'L', 8000, 3000, 0.06],
    ['Tea powder', 'g', 'g', 600, 200, 0.5],
    ['Sugar', 'g', 'kg', 4500, 1000, 0.045],
    ['Coffee powder', 'g', 'g', 350, 150, 0.9],
    ['Maggi', 'packet', 'packet', 14, 10, 14],
    ['Bread', 'packet', 'packet', 3, 2, 40],
    ['Eggs', 'pcs', 'dozen', 22, 12, 6],
    ['Maida', 'g', 'kg', 2500, 2000, 0.042],
    ['Oil', 'ml', 'L', 1800, 1000, 0.15],
    ['Potato', 'g', 'kg', 4000, 2000, 0.03],
    ['Paneer', 'g', 'g', 400, 500, 0.4],
  ]
  let id = nextId
  const ingredients: Ingredient[] = list.map(([name, base_unit, display_unit, on_hand, low_at, cost]) => ({
    id: uuid(), name, base_unit, display_unit, on_hand, low_at, cost_per_unit: cost, is_active: true, updated_at: at(today, 9),
  }))
  const ing = (n: string) => ingredients.find((i) => i.name === n)!
  const moves: IngredientMovement[] = []
  for (const i of ingredients) {
    const bought = i.base_unit === 'packet' ? 20 : i.base_unit === 'pcs' ? 60 : i.on_hand * 2
    moves.push({ id: id++, ingredient_id: i.id, ingredient_name: i.name, kind: 'opening', delta: 0, on_hand_after: 0, unit_cost: null, amount: null, order_id: null, note: null, actor_name: 'Asha (Owner)', created_at: at(addDays(today, -6), 8) })
    moves.push({ id: id++, ingredient_id: i.id, ingredient_name: i.name, kind: 'purchase', delta: bought, on_hand_after: bought, unit_cost: i.cost_per_unit, amount: Math.round(bought * (i.cost_per_unit ?? 0)), order_id: null, note: null, actor_name: 'Asha (Owner)', created_at: at(addDays(today, -6), 8.2) })
    moves.push({ id: id++, ingredient_id: i.id, ingredient_name: i.name, kind: 'count', delta: i.on_hand - bought, on_hand_after: i.on_hand, unit_cost: null, amount: null, order_id: null, note: 'Morning count', actor_name: 'Asha (Owner)', created_at: at(today, 8.5) })
  }
  moves.push({ id: id++, ingredient_id: ing('Milk').id, ingredient_name: 'Milk', kind: 'waste', delta: -500, on_hand_after: 8000, unit_cost: 0.06, amount: null, order_id: null, note: 'Spoiled', actor_name: 'Asha (Owner)', created_at: at(addDays(today, -2), 19) })
  const byName = (n: string) => items.find((i) => i.name === n)
  const recipe: [string, [string, number][]][] = [
    ['Masala Chai', [['Milk', 100], ['Tea powder', 4], ['Sugar', 10]]],
    ['Filter Coffee', [['Milk', 120], ['Coffee powder', 8], ['Sugar', 8]]],
    ['Cold Coffee', [['Milk', 200], ['Coffee powder', 6], ['Sugar', 15]]],
    ['College Special Maggi', [['Maggi', 1]]],
    ['Maggi + Chai Combo', [['Maggi', 1], ['Milk', 100], ['Tea powder', 4], ['Sugar', 10]]],
    ['Bread Omelette', [['Eggs', 2], ['Bread', 0.25]]],
    ['Crispy Samosa', [['Maida', 60], ['Potato', 80], ['Oil', 30]]],
    ['Paneer Wrap', [['Paneer', 60], ['Maida', 50], ['Oil', 10]]],
  ]
  const recipes: Recipes = {}
  for (const [item, lines] of recipe) {
    const m = byName(item)
    if (m) recipes[m.id] = lines.map(([n, q]) => ({ ingredient_id: ing(n).id, quantity: q }))
  }
  return { ingredients, ingredientMoves: moves, recipes, nextId: id }
}

function freshStore(): Store {
  const menu = seedMenu()
  const costs = seedCosts(menu.items)
  const { orders, next } = seedOrders(menu.items, costs)
  const business = seedBusiness(menu.items, costs)
  const raw = seedIngredients(menu.items, business.nextId)
  const created = new Date(Date.now() - 30 * 86400000).toISOString()
  return {
    version: 4,
    settings: { ...catalog.settings, updated_at: now() },
    categories: menu.categories,
    items: menu.items,
    tables: catalog.tables.map((label) => ({ label, is_active: true })),
    orders,
    staff: DEMO_ACCOUNTS.map((a) => ({
      user_id: a.user_id, display_name: a.name, role: a.role, is_active: true, created_at: created, email: a.email, last_sign_in_at: null,
    })),
    accounts: DEMO_ACCOUNTS.map(({ email, password, user_id }) => ({ email, password, user_id })),
    nextOrderNo: next,
    costs,
    ...business,
    ...raw,
  }
}

function load(): Store {
  const s = readJson<Store | null>(STORE_KEY, null)
  if (s && s.version === 4) return s
  const fresh = freshStore()
  writeJson(STORE_KEY, fresh)
  return fresh
}

export function resetDemoData() {
  writeJson(STORE_KEY, freshStore())
  notify(null)
}

// ---- change notifications (same tab + other tabs) -------------------------
type Listener = (orderId: string | null) => void
const listeners = new Set<Listener>()
let bc: BroadcastChannel | null = null
try {
  bc = new BroadcastChannel('bitesip-demo')
  bc.onmessage = (e) => listeners.forEach((l) => l((e.data as { orderId: string | null }).orderId))
} catch {
  bc = null
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORE_KEY) listeners.forEach((l) => l(null))
  })
}
function notify(orderId: string | null) {
  listeners.forEach((l) => l(orderId))
  try {
    bc?.postMessage({ orderId })
  } catch {
    /* ignore */
  }
}

function mutate<T>(fn: (s: Store) => T, orderId: string | null = null): T {
  const s = load()
  const result = fn(s)
  writeJson(STORE_KEY, s)
  notify(orderId)
  return result
}

// ---- helpers ---------------------------------------------------------------
function toCustomer(o: DemoOrder): CustomerOrder {
  return {
    id: o.id, order_no: o.order_no, customer_name: o.customer_name, phone_last4: o.customer_phone.slice(-4),
    table_label: o.table_label, status: o.status, payment_method: o.payment_method, payment_status: o.payment_status,
    customer_reported_paid_at: o.customer_reported_paid_at, total: o.total, item_count: o.item_count,
    cancel_reason: o.cancel_reason, cancelled_by: o.cancelled_by, track_key: o.track_key, created_at: o.created_at,
    updated_at: o.updated_at, preparing_at: o.preparing_at, ready_at: o.ready_at, completed_at: o.completed_at,
    cancelled_at: o.cancelled_at, paid_at: o.paid_at, items: clone(o.items),
  }
}

function toStaff(o: DemoOrder): StaffOrder {
  const { token: _t, track_key: _k, client_request_id: _c, line_costs: _l, ...rest } = o
  return clone(rest)
}

function session(): { user_id: string; role: StaffRole; name: string } | null {
  const id = readJson<string | null>(SESSION_KEY, null)
  if (!id) return null
  const member = load().staff.find((m) => m.user_id === id && m.is_active)
  return member ? { user_id: member.user_id, role: member.role, name: member.display_name } : null
}

function requireStaff() {
  const s = session()
  if (!s) throw new AppError('not_allowed')
  return s
}

function requireOwner() {
  const s = requireStaff()
  if (s.role !== 'owner') throw new AppError('owner_only')
  return s
}

function findCustomerOrder(s: Store, id: string, token: string) {
  const o = s.orders.find((x) => x.id === id && x.token === token)
  if (!o || !/^[0-9a-f]{64}$/.test(token)) throw new AppError('order_not_found')
  return o
}

/** {field: [before, after]} for the given keys that differ. */
function diff<T extends object>(before: T | null, after: T | null, keys: (keyof T)[]): AuditEntry['changes'] {
  const out: AuditEntry['changes'] = {}
  for (const k of keys) {
    const a = before ? before[k] ?? null : null
    const b = after ? after[k] ?? null : null
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k as string] = [a, b]
  }
  return out
}

function audit(s: Store, actorName: string, action: string, entity: string, entityId: string | null, label: string | null, changes: AuditEntry['changes']) {
  if (action.endsWith('.updated') && Object.keys(changes).length === 0) return
  s.audit.push({ id: s.nextId++, at: now(), actor: null, actor_name: actorName, action, entity, entity_id: entityId, label, changes })
}

const orderLabel = (o: StaffOrder) => `Order BS-${o.order_no} · ₹${o.total} ${o.payment_method.toUpperCase()}`

/** Deducts recipe ingredients for an order (never blocks: stock may go below zero). */
function useIngredients(s: Store, o: DemoOrder, lines: { menu_item_id: string; quantity: number }[]) {
  const need = new Map<string, number>()
  for (const l of lines) for (const r of s.recipes[l.menu_item_id] ?? []) need.set(r.ingredient_id, (need.get(r.ingredient_id) ?? 0) + r.quantity * l.quantity)
  for (const [id, qty] of need) {
    const ing = s.ingredients.find((i) => i.id === id && i.is_active)
    if (!ing) continue
    ing.on_hand = Math.round((ing.on_hand - qty) * 1000) / 1000
    ing.updated_at = o.created_at
    s.ingredientMoves.push({
      id: s.nextId++, ingredient_id: id, ingredient_name: ing.name, kind: 'sale', delta: -qty, on_hand_after: ing.on_hand,
      unit_cost: null, amount: null, order_id: o.id, note: null, actor_name: 'Customer', created_at: o.created_at,
    })
  }
}

/** Puts an order's tracked items and recipe ingredients back when it is cancelled. */
function restock(s: Store, o: DemoOrder, actor: string) {
  const used = new Map<string, number>()
  for (const m of s.ingredientMoves.filter((x) => x.order_id === o.id && (x.kind === 'sale' || x.kind === 'cancel_return') && x.ingredient_id)) {
    used.set(m.ingredient_id!, (used.get(m.ingredient_id!) ?? 0) - m.delta)
  }
  for (const [id, qty] of used) {
    const ing = s.ingredients.find((i) => i.id === id)
    if (!ing || qty <= 0) continue
    ing.on_hand = Math.round((ing.on_hand + qty) * 1000) / 1000
    ing.updated_at = now()
    s.ingredientMoves.push({
      id: s.nextId++, ingredient_id: id, ingredient_name: ing.name, kind: 'cancel_return', delta: qty, on_hand_after: ing.on_hand,
      unit_cost: null, amount: null, order_id: o.id, note: null, actor_name: actor, created_at: now(),
    })
  }
  const sold = new Map<string, { name: string; qty: number }>()
  for (const m of s.movements.filter((x) => x.order_id === o.id && (x.kind === 'sale' || x.kind === 'cancel_return') && x.menu_item_id)) {
    const v = sold.get(m.menu_item_id!) ?? { name: m.item_name, qty: 0 }
    v.qty -= m.delta
    sold.set(m.menu_item_id!, v)
  }
  for (const [itemId, v] of sold) {
    const level = s.stock.find((x) => x.menu_item_id === itemId)
    if (!level || v.qty <= 0) continue
    level.on_hand += v.qty
    level.updated_at = now()
    s.movements.push({
      id: s.nextId++, menu_item_id: itemId, item_name: v.name, kind: 'cancel_return', delta: v.qty, on_hand_after: level.on_hand,
      unit_cost: null, order_id: o.id, note: null, actor_name: actor, created_at: now(),
    })
  }
}

const MENU_AUDIT_KEYS: (keyof MenuItem)[] = ['name', 'description', 'price', 'category_id', 'is_veg', 'is_available', 'is_popular', 'image_path']
const EXPENSE_CATS = ['ingredients', 'salaries', 'rent', 'utilities', 'gas', 'packaging', 'maintenance', 'marketing', 'other']

function validExpense(input: ExpenseInput): ExpenseInput {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.spent_on)) throw new AppError('invalid', 'Choose a date.')
  if (!EXPENSE_CATS.includes(input.category)) throw new AppError('invalid', 'Choose a category.')
  if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > 10_000_000) throw new AppError('invalid', 'Enter an amount in whole rupees.')
  const note = input.note ? cleanText(input.note) : ''
  if (note.length > 140) throw new AppError('invalid', 'Notes can be up to 140 characters.')
  return { ...input, note: note || null }
}

// ---- backend ---------------------------------------------------------------
export function createDemoBackend(): Backend {
  return {
    mode: 'demo',

    async getPublicData(): Promise<PublicData> {
      await delay()
      const s = load()
      return {
        settings: clone(s.settings),
        menu: { categories: clone(s.categories).sort((a, b) => a.sort_order - b.sort_order), items: clone(s.items).sort((a, b) => a.sort_order - b.sort_order) },
        tables: clone(s.tables),
        stock: clone(s.stock),
      }
    },

    async placeOrder(input: PlaceOrderInput) {
      await delay(400)
      return mutate((s) => {
        const existing = s.orders.find((o) => o.client_request_id === input.client_request_id)
        if (existing) {
          if (existing.token !== input.access_token) throw new AppError('invalid_request')
          return toCustomer(existing)
        }
        if (!/^[0-9a-f]{64}$/.test(input.access_token)) throw new AppError('invalid_request')
        if (!s.settings.is_open) throw new AppError('cafe_closed')
        const name = cleanText(input.customer_name)
        if (!name || name.length > 40) throw new AppError('invalid_name')
        const phone = normalizePhone(input.customer_phone)
        if (!phone) throw new AppError('invalid_phone')
        if (input.payment_method === 'upi' && !s.settings.upi_id) throw new AppError('upi_unavailable')
        let table = normalizeTableLabel(input.table_label)
        if (table && !s.tables.some((t) => t.label === table && t.is_active)) table = null
        if (!input.items.length || input.items.length > MAX_LINES) throw new AppError('invalid_items')
        const open = s.orders.filter((o) => o.customer_phone === phone && OPEN_STATUSES.includes(o.status)).length
        if (open >= 3) throw new AppError('too_many_open_orders')

        const lineCosts: (number | null)[] = []
        const wanted = new Map<string, { item: MenuItem; qty: number }>()
        const lines: OrderLine[] = input.items.map((l) => {
          if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > MAX_QTY_PER_LINE) throw new AppError('invalid_quantity')
          const item = s.items.find((i) => i.id === l.menu_item_id)
          if (!item) throw new AppError('item_not_found')
          if (!item.is_available) throw new AppError('item_unavailable', `${item.name} just sold out. Please remove it from your cart.`)
          if (new Set(l.addon_ids).size !== l.addon_ids.length) throw new AppError('invalid_addons')
          const valid = item.addons.filter((a) => l.addon_ids.includes(a.id) && a.is_available)
          if (valid.length !== l.addon_ids.length) throw new AppError('addon_unavailable')
          const note = l.note ? cleanText(l.note) : null
          if (note && note.length > 120) throw new AppError('invalid_note')
          lineCosts.push(lineCost(s.costs, item, l.addon_ids))
          const w = wanted.get(item.id) ?? { item, qty: 0 }
          w.qty += l.quantity
          wanted.set(item.id, w)
          return buildLine(item, l.quantity, l.addon_ids, note || null)
        })
        const units = lines.reduce((x, l) => x + l.quantity, 0)
        if (units > MAX_UNITS) throw new AppError('invalid_quantity')

        const short = [...wanted.values()]
          .map((w) => ({ ...w, level: s.stock.find((x) => x.menu_item_id === w.item.id) }))
          .filter((w) => w.level && w.level.on_hand < w.qty)
          .sort((a, b) => a.item.name.localeCompare(b.item.name))[0]
        if (short) {
          if (short.level!.on_hand === 0) throw new AppError('item_unavailable', `${short.item.name} just sold out. Please remove it from your cart.`)
          throw new AppError('insufficient_stock', `Only ${short.level!.on_hand} ${short.item.name} left. Please lower the quantity.`)
        }

        const created = now()
        const order: DemoOrder = {
          id: uuid(), order_no: s.nextOrderNo++, customer_name: name, customer_phone: phone, table_label: table,
          status: 'placed', payment_method: input.payment_method, payment_status: 'unpaid', customer_reported_paid_at: null,
          payment_reference: null, total: lines.reduce((x, l) => x + l.line_total, 0), item_count: units,
          cancel_reason: null, cancelled_by: null, created_at: created, updated_at: created, preparing_at: null,
          ready_at: null, completed_at: null, cancelled_at: null, paid_at: null, items: lines, line_costs: lineCosts,
          token: input.access_token, track_key: uuid(), client_request_id: input.client_request_id,
        }
        s.orders.push(order)
        for (const w of wanted.values()) {
          const level = s.stock.find((x) => x.menu_item_id === w.item.id)
          if (!level) continue
          level.on_hand -= w.qty
          level.updated_at = created
          s.movements.push({
            id: s.nextId++, menu_item_id: w.item.id, item_name: w.item.name, kind: 'sale', delta: -w.qty, on_hand_after: level.on_hand,
            unit_cost: null, order_id: order.id, note: null, actor_name: 'Customer', created_at: created,
          })
        }
        useIngredients(s, order, input.items.map((l) => ({ menu_item_id: l.menu_item_id, quantity: l.quantity })))
        return toCustomer(order)
      })
    },

    async getOrder(id, token) {
      await delay(80)
      return toCustomer(findCustomerOrder(load(), id, token))
    },

    async getOrders(refs) {
      await delay(80)
      const s = load()
      return refs.slice(0, 20).flatMap((r) => {
        try {
          return [toCustomer(findCustomerOrder(s, r.id, r.token))]
        } catch {
          return []
        }
      })
    },

    async reportUpiPayment(id, token) {
      await delay()
      return mutate((s) => {
        const o = findCustomerOrder(s, id, token)
        if (o.payment_method !== 'upi' || o.status === 'cancelled') throw new AppError('not_allowed')
        if (o.payment_status === 'unpaid' && !o.customer_reported_paid_at) {
          o.customer_reported_paid_at = now()
          o.updated_at = now()
        }
        return toCustomer(o)
      }, id)
    },

    async cancelMyOrder(id, token) {
      await delay()
      return mutate((s) => {
        const o = findCustomerOrder(s, id, token)
        if (o.status !== 'placed' || o.payment_status !== 'unpaid' || o.customer_reported_paid_at) throw new AppError('cannot_cancel')
        o.status = 'cancelled'
        o.cancelled_at = now()
        o.cancelled_by = 'customer'
        o.cancel_reason = 'Cancelled by customer'
        o.updated_at = now()
        restock(s, o, 'Customer')
        audit(s, 'Customer', 'order.cancelled', 'order', o.id, orderLabel(o), { status: ['placed', 'cancelled'], cancel_reason: [null, o.cancel_reason] })
        return toCustomer(o)
      }, id)
    },

    watchOrder(trackKey, onChange, onStatus) {
      const id = load().orders.find((o) => o.track_key === trackKey)?.id
      const l: Listener = (orderId) => {
        if (orderId === null || orderId === id) onChange()
      }
      listeners.add(l)
      setTimeout(() => onStatus('live'), 0)
      return () => listeners.delete(l)
    },

    imageUrl(path) {
      if (isBundledImage(path)) return bundledImage(path)!.src
      return path && path.startsWith('data:') ? path : null
    },

    async getStaffSession() {
      const s = session()
      if (!s) return null
      const st = load()
      const member = st.staff.find((m) => m.user_id === s.user_id)!
      return { user_id: s.user_id, email: member.email, display_name: member.display_name, role: member.role, is_active: true }
    },

    async signIn(email, password) {
      await delay(300)
      const st = load()
      const account = st.accounts.find((a) => a.email === email.trim().toLowerCase() && a.password === password)
      if (!account) throw new AppError('invalid_credentials')
      const member = st.staff.find((m) => m.user_id === account.user_id)
      if (!member?.is_active) throw new AppError('not_staff')
      writeJson(SESSION_KEY, account.user_id)
      mutate((s) => {
        const m = s.staff.find((x) => x.user_id === account.user_id)
        if (m) m.last_sign_in_at = now()
      })
      authListeners.forEach((cb) => cb())
      return { user_id: account.user_id, email: account.email, display_name: member.display_name, role: member.role, is_active: true } satisfies StaffProfile
    },

    async signOut() {
      writeJson(SESSION_KEY, null)
      authListeners.forEach((cb) => cb())
    },

    onAuthChange(cb) {
      authListeners.add(cb)
      return () => authListeners.delete(cb)
    },

    async listOrdersSince(sinceIso) {
      await delay(80)
      requireStaff()
      return load()
        .orders.filter((o) => OPEN_STATUSES.includes(o.status) || o.created_at >= sinceIso)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map(toStaff)
    },

    async listOrdersInRange(fromDay, toDay) {
      await delay(80)
      requireStaff()
      const from = cafeDayStartIso(fromDay)
      const to = cafeDayStartIso(addDays(toDay, 1))
      return load()
        .orders.filter((o) => o.created_at >= from && o.created_at < to)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map(toStaff)
    },

    async changeStatus(id, change) {
      await delay()
      const me = requireStaff()
      return mutate((s) => {
        const o = s.orders.find((x) => x.id === id)
        if (!o || o.status !== change.from) throw new AppError('conflict')
        if (!canTransition(o.status, change.to)) throw new AppError('invalid_transition')
        const t = now()
        const wasPaid = o.payment_status
        if (change.markPaid && o.payment_status === 'unpaid') {
          o.payment_status = 'paid'
          o.paid_at = t
        }
        if (change.to === 'completed' && o.payment_status !== 'paid') throw new AppError('payment_required')
        if (change.to === 'cancelled') {
          const reason = cleanText(change.reason ?? '')
          if (!reason) throw new AppError('cancel_reason_required')
          o.cancel_reason = reason
          o.cancelled_by = 'staff'
          o.cancelled_at = t
        }
        if (change.to === 'preparing') o.preparing_at = t
        if (change.to === 'ready') o.ready_at = t
        if (change.to === 'completed') o.completed_at = t
        const from = o.status
        o.status = change.to
        o.updated_at = t
        if (wasPaid !== o.payment_status) {
          audit(s, me.name, 'order.marked_paid', 'order', o.id, orderLabel(o), { payment_status: [wasPaid, o.payment_status] })
        }
        if (change.to === 'cancelled') {
          restock(s, o, me.name)
          audit(s, me.name, 'order.cancelled', 'order', o.id, orderLabel(o), { status: [from, 'cancelled'], cancel_reason: [null, o.cancel_reason] })
        }
        return toStaff(o)
      }, id)
    },

    async setPayment(id, paid, reference) {
      await delay()
      const me = requireStaff()
      return mutate((s) => {
        const o = s.orders.find((x) => x.id === id)
        if (!o || o.payment_status === (paid ? 'paid' : 'unpaid')) throw new AppError('conflict')
        if (o.status === 'cancelled') throw new AppError('order_cancelled')
        const before = { payment_status: o.payment_status, payment_reference: o.payment_reference }
        if (!paid) {
          if (me.role !== 'owner') throw new AppError('owner_only')
          if (o.status === 'completed') throw new AppError('payment_required')
          o.payment_status = 'unpaid'
          o.paid_at = null
          o.payment_reference = null
        } else {
          o.payment_status = 'paid'
          o.paid_at = now()
          o.payment_reference = reference ? cleanText(reference).slice(0, 40) || null : null
        }
        o.updated_at = now()
        audit(s, me.name, paid ? 'order.marked_paid' : 'order.marked_unpaid', 'order', o.id, orderLabel(o),
          diff(before, { payment_status: o.payment_status, payment_reference: o.payment_reference }, ['payment_status', 'payment_reference']))
        return toStaff(o)
      }, id)
    },

    watchOrders(onChange, onStatus) {
      listeners.add(onChange)
      setTimeout(() => onStatus('live' as LiveStatus), 0)
      return () => listeners.delete(onChange)
    },

    async saveMenuItem(input: MenuItemInput) {
      await delay()
      const me = requireOwner()
      return mutate((s) => {
        const name = cleanText(input.name)
        if (!name || name.length > 60 || !Number.isInteger(input.price) || input.price < 1 || input.price > 5000) throw new AppError('invalid')
        if (!s.categories.some((c) => c.id === input.category_id)) throw new AppError('invalid')
        const validCost = (c: number | null | undefined, max: number) => c === undefined || c === null || (Number.isInteger(c) && c >= 0 && c <= max)
        if (!validCost(input.cost, 5000) || input.addons.some((a) => !validCost(a.cost, 1000))) throw new AppError('invalid_cost')
        const id = input.id ?? uuid()
        const existing = s.items.find((i) => i.id === id)
        const before = existing ? clone(existing) : null
        const names = input.addons.map((a) => cleanText(a.name).toLowerCase())
        if (new Set(names).size !== names.length) throw new AppError('duplicate', 'Two add-ons have the same name.')
        const item: MenuItem = {
          id,
          category_id: input.category_id,
          name,
          description: cleanText(input.description).slice(0, 200),
          price: input.price,
          is_veg: input.is_veg,
          is_available: input.is_available,
          is_popular: input.is_popular,
          image_path: input.image_path,
          sort_order: existing?.sort_order ?? Math.max(0, ...s.items.filter((i) => i.category_id === input.category_id).map((i) => i.sort_order)) + 1,
          addons: input.addons.map((a, idx) => ({
            id: a.id ?? uuid(), menu_item_id: id, name: cleanText(a.name), price: a.price, is_available: a.is_available, sort_order: idx + 1,
          })),
        }
        if (existing) Object.assign(existing, item)
        else s.items.push(item)
        audit(s, me.name, existing ? 'menu_item.updated' : 'menu_item.created', 'menu_item', id, name, diff(before, item, MENU_AUDIT_KEYS))

        const setCost = (map: Record<string, number>, key: string, cost: number | null | undefined, label: string) => {
          if (cost === undefined) return
          const old = map[key] ?? null
          if (old === cost) return
          if (cost === null) delete map[key]
          else map[key] = cost
          audit(s, me.name, old === null ? 'cost.set' : cost === null ? 'cost.removed' : 'cost.changed', 'cost', key, label, { cost: [old, cost] })
        }
        setCost(s.costs.items, id, input.cost, name)
        item.addons.forEach((a, idx) => setCost(s.costs.addons, a.id, input.addons[idx].cost, `${name} › ${a.name}`))
        for (const old of before?.addons ?? []) if (!item.addons.some((a) => a.id === old.id)) delete s.costs.addons[old.id]

        if (input.recipe !== undefined) {
          const lines = input.recipe
          if (lines.length > 30 || lines.some((l) => !(l.quantity > 0 && l.quantity <= 100000) || !s.ingredients.some((i) => i.id === l.ingredient_id && i.is_active))) {
            throw new AppError('invalid_recipe')
          }
          const old = s.recipes[id] ?? []
          const ingName = (iid: string) => s.ingredients.find((i) => i.id === iid)?.name ?? '?'
          for (const o of old) if (!lines.some((l) => l.ingredient_id === o.ingredient_id)) audit(s, me.name, 'recipe.removed', 'recipe', id, `${name} › ${ingName(o.ingredient_id)}`, { quantity: [o.quantity, null] })
          for (const l of lines) {
            const prev = old.find((o) => o.ingredient_id === l.ingredient_id)
            const q = Math.round(l.quantity * 1000) / 1000
            if (!prev) audit(s, me.name, 'recipe.added', 'recipe', id, `${name} › ${ingName(l.ingredient_id)}`, { quantity: [null, q] })
            else if (prev.quantity !== q) audit(s, me.name, 'recipe.changed', 'recipe', id, `${name} › ${ingName(l.ingredient_id)}`, { quantity: [prev.quantity, q] })
          }
          if (lines.length) s.recipes[id] = lines.map((l) => ({ ingredient_id: l.ingredient_id, quantity: Math.round(l.quantity * 1000) / 1000 }))
          else delete s.recipes[id]
        }
        return id
      })
    },

    async deleteMenuItem(id) {
      await delay()
      const me = requireOwner()
      mutate((s) => {
        const item = s.items.find((i) => i.id === id)
        if (!item) return
        s.items = s.items.filter((i) => i.id !== id)
        s.stock = s.stock.filter((x) => x.menu_item_id !== id)
        delete s.costs.items[id]
        for (const m of s.movements) if (m.menu_item_id === id) m.menu_item_id = null
        audit(s, me.name, 'menu_item.deleted', 'menu_item', id, item.name, diff(item, null, ['name', 'price']))
      })
    },

    async setItemAvailability(id, available) {
      await delay(80)
      const me = requireStaff()
      mutate((s) => {
        const i = s.items.find((x) => x.id === id)
        if (!i) throw new AppError('not_allowed')
        if (i.is_available === available) return
        audit(s, me.name, 'menu_item.updated', 'menu_item', id, i.name, { is_available: [i.is_available, available] })
        i.is_available = available
      })
    },

    async setAddonAvailability(id, available) {
      await delay(80)
      const me = requireStaff()
      mutate((s) => {
        const item = s.items.find((i) => i.addons.some((a) => a.id === id))
        const a = item?.addons.find((x) => x.id === id)
        if (!item || !a) throw new AppError('not_allowed')
        if (a.is_available === available) return
        audit(s, me.name, 'addon.updated', 'addon', id, `${item.name} › ${a.name}`, { is_available: [a.is_available, available] })
        a.is_available = available
      })
    },

    async uploadImage(file) {
      requireOwner()
      if (file.size > 2 * 1024 * 1024) throw new AppError('invalid', 'Images must be under 2 MB.')
      return await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result))
        r.onerror = () => reject(new AppError('unknown'))
        r.readAsDataURL(file)
      })
    },

    async removeImage() {
      /* data URLs are dropped with the item */
    },

    async createCategory(name) {
      await delay()
      const me = requireOwner()
      return mutate((s) => {
        const clean = cleanText(name)
        if (!clean || clean.length > 40) throw new AppError('invalid')
        if (s.categories.some((c) => c.name.toLowerCase() === clean.toLowerCase())) throw new AppError('duplicate', 'That name is already in use.')
        const c = { id: uuid(), name: clean, sort_order: Math.max(0, ...s.categories.map((x) => x.sort_order)) + 1 }
        s.categories.push(c)
        audit(s, me.name, 'category.created', 'category', c.id, clean, { name: [null, clean] })
        return c
      })
    },

    async updateCategory(id, patch) {
      await delay()
      const me = requireOwner()
      mutate((s) => {
        const c = s.categories.find((x) => x.id === id)
        if (!c) throw new AppError('not_allowed')
        if (patch.name !== undefined) {
          const clean = cleanText(patch.name)
          if (!clean || clean.length > 40) throw new AppError('invalid')
          if (s.categories.some((x) => x.id !== id && x.name.toLowerCase() === clean.toLowerCase())) throw new AppError('duplicate', 'That name is already in use.')
          audit(s, me.name, 'category.updated', 'category', id, clean, diff(c, { ...c, name: clean }, ['name']))
          c.name = clean
        }
        if (patch.sort_order !== undefined) c.sort_order = patch.sort_order
      })
    },

    async deleteCategory(id) {
      await delay()
      const me = requireOwner()
      mutate((s) => {
        if (s.items.some((i) => i.category_id === id)) throw new AppError('in_use', 'This is still in use and can’t be deleted.')
        const c = s.categories.find((x) => x.id === id)
        s.categories = s.categories.filter((x) => x.id !== id)
        if (c) audit(s, me.name, 'category.deleted', 'category', id, c.name, { name: [c.name, null] })
      })
    },

    async updateSettings(patch) {
      await delay()
      const me = requireOwner()
      return mutate((s) => {
        if (patch.upi_id !== undefined && patch.upi_id !== null && !isValidUpiId(patch.upi_id)) throw new AppError('invalid', 'Enter a valid UPI ID, like cafe@okaxis.')
        const before = clone(s.settings)
        Object.assign(s.settings, patch, { updated_at: now() })
        audit(s, me.name, 'settings.updated', 'settings', 'true', 'Café settings',
          diff(before, s.settings, ['cafe_name', 'is_open', 'closed_message', 'upi_id', 'upi_payee_name']))
        return clone(s.settings)
      })
    },

    async addTables(labels) {
      await delay()
      const me = requireOwner()
      mutate((s) => {
        for (const label of labels) {
          const t = s.tables.find((x) => x.label === label)
          if (t) {
            if (!t.is_active) audit(s, me.name, 'table.updated', 'table', label, label, { is_active: [false, true] })
            t.is_active = true
          } else {
            s.tables.push({ label, is_active: true })
            audit(s, me.name, 'table.created', 'table', label, label, { label: [null, label] })
          }
        }
        s.tables.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
      })
    },

    async setTableActive(label, active) {
      await delay(80)
      const me = requireOwner()
      mutate((s) => {
        const t = s.tables.find((x) => x.label === label)
        if (!t) throw new AppError('not_allowed')
        if (t.is_active !== active) audit(s, me.name, 'table.updated', 'table', label, label, { is_active: [t.is_active, active] })
        t.is_active = active
      })
    },

    async deleteTable(label) {
      await delay(80)
      const me = requireOwner()
      mutate((s) => {
        if (s.tables.some((t) => t.label === label)) audit(s, me.name, 'table.deleted', 'table', label, label, { label: [label, null] })
        s.tables = s.tables.filter((t) => t.label !== label)
      })
    },

    async listStaff() {
      await delay(80)
      requireOwner()
      return clone(load().staff)
    },

    async updateStaff(userId, patch) {
      await delay()
      const me = requireOwner()
      mutate((s) => {
        const m = s.staff.find((x) => x.user_id === userId)
        if (!m) throw new AppError('owner_only')
        if (userId === me.user_id && ((patch.role && patch.role !== m.role) || patch.is_active === false)) throw new AppError('cannot_change_own_role_or_status')
        const before = clone(m)
        Object.assign(m, patch)
        audit(s, me.name, 'staff.updated', 'staff', userId, m.display_name, diff(before, m, ['display_name', 'role', 'is_active']))
      })
    },

    async changeOwnPassword(current, next) {
      await delay(300)
      const me = requireStaff()
      mutate((s) => {
        const account = s.accounts.find((a) => a.user_id === me.user_id)
        if (!account || account.password !== current) throw new AppError('wrong_password')
        if (next.length < 8 || next.length > 72) throw new AppError('weak_password')
        account.password = next
      })
    },

    async salesSummary(fromDay, toDay) {
      await delay()
      requireOwner()
      if (toDay < fromDay || addDays(fromDay, 92) < toDay) throw new AppError('invalid_range')
      return summarize(load().orders.map(toStaff), fromDay, toDay)
    },

    async getCosts() {
      await delay(80)
      requireOwner()
      return clone(load().costs)
    },

    async profitAndLoss(fromDay, toDay) {
      await delay()
      requireOwner()
      if (toDay < fromDay || addDays(fromDay, 366) < toDay) throw new AppError('invalid_range')
      const s = load()
      return computeProfitAndLoss(
        s.orders.map((o) => ({ ...toStaff(o), line_costs: o.line_costs })),
        s.expenses,
        s.movements,
        fromDay,
        toDay,
        s.ingredientMoves,
      )
    },

    async listExpenses(fromDay, toDay) {
      await delay(80)
      requireOwner()
      return clone(load().expenses)
        .filter((e) => e.spent_on >= fromDay && e.spent_on <= toDay)
        .sort((a, b) => b.spent_on.localeCompare(a.spent_on) || b.created_at.localeCompare(a.created_at))
    },

    async addExpense(input) {
      await delay()
      const me = requireOwner()
      return mutate((s) => {
        const v = validExpense(input)
        const e: Expense = { id: uuid(), ...v, created_at: now(), updated_at: now() }
        s.expenses.push(e)
        audit(s, me.name, 'expense.created', 'expense', e.id, e.category, diff(null, e, ['spent_on', 'category', 'amount', 'note']))
        return clone(e)
      })
    },

    async updateExpense(id, input) {
      await delay()
      const me = requireOwner()
      return mutate((s) => {
        const e = s.expenses.find((x) => x.id === id)
        if (!e) throw new AppError('owner_only')
        const before = clone(e)
        Object.assign(e, validExpense(input), { updated_at: now() })
        audit(s, me.name, 'expense.updated', 'expense', id, e.category, diff(before, e, ['spent_on', 'category', 'amount', 'note']))
        return clone(e)
      })
    },

    async deleteExpense(id) {
      await delay()
      const me = requireOwner()
      mutate((s) => {
        const e = s.expenses.find((x) => x.id === id)
        if (!e) throw new AppError('owner_only')
        s.expenses = s.expenses.filter((x) => x.id !== id)
        audit(s, me.name, 'expense.deleted', 'expense', id, e.category, diff(e, null, ['spent_on', 'category', 'amount', 'note']))
      })
    },

    async getStock() {
      await delay(80)
      return clone(load().stock)
    },

    async configureStock(menuItemId, track, lowAt, onHand) {
      await delay()
      const me = requireOwner()
      mutate((s) => {
        const item = s.items.find((i) => i.id === menuItemId)
        if (!item) throw new AppError('item_not_found')
        if ((lowAt !== null && (!Number.isInteger(lowAt) || lowAt < 0 || lowAt > 10000)) || (onHand !== null && (!Number.isInteger(onHand) || onHand < 0 || onHand > 100000))) {
          throw new AppError('invalid_quantity')
        }
        const level = s.stock.find((x) => x.menu_item_id === menuItemId)
        if (!track) {
          if (level) {
            s.stock = s.stock.filter((x) => x.menu_item_id !== menuItemId)
            audit(s, me.name, 'stock.tracking_off', 'stock', menuItemId, item.name, { on_hand: [level.on_hand, null] })
          }
          return
        }
        if (!level) {
          const created: StockLevel = { menu_item_id: menuItemId, on_hand: onHand ?? 0, low_at: lowAt ?? 5, updated_at: now() }
          s.stock.push(created)
          s.movements.push({
            id: s.nextId++, menu_item_id: menuItemId, item_name: item.name, kind: 'initial', delta: created.on_hand, on_hand_after: created.on_hand,
            unit_cost: null, order_id: null, note: null, actor_name: me.name, created_at: now(),
          })
          audit(s, me.name, 'stock.tracking_on', 'stock', menuItemId, item.name, { on_hand: [null, created.on_hand], low_at: [null, created.low_at] })
        } else if (lowAt !== null && lowAt !== level.low_at) {
          audit(s, me.name, 'stock.low_level_changed', 'stock', menuItemId, item.name, { low_at: [level.low_at, lowAt] })
          level.low_at = lowAt
          level.updated_at = now()
        }
      })
    },

    async adjustStock(menuItemId, kind, quantity, note) {
      await delay()
      const me = requireStaff()
      return mutate((s) => {
        if (!['restock', 'waste', 'count', 'correction'].includes(kind)) throw new AppError('invalid_request')
        if (!Number.isInteger(quantity)) throw new AppError('invalid_quantity')
        const clean = note ? cleanText(note) : ''
        if (clean.length > 140) throw new AppError('invalid_note')
        const level = s.stock.find((x) => x.menu_item_id === menuItemId)
        if (!level) throw new AppError('stock_not_tracked')
        const item = s.items.find((i) => i.id === menuItemId)!
        let delta: number
        if (kind === 'restock') {
          if (quantity < 1 || quantity > 10000) throw new AppError('invalid_quantity')
          delta = quantity
        } else if (kind === 'waste') {
          if (quantity < 1) throw new AppError('invalid_quantity')
          if (quantity > level.on_hand) throw new AppError('insufficient_stock', `Only ${level.on_hand} ${item.name} in stock.`)
          delta = -quantity
        } else if (kind === 'count') {
          if (quantity < 0 || quantity > 100000) throw new AppError('invalid_quantity')
          delta = quantity - level.on_hand
        } else {
          if (quantity === 0 || Math.abs(quantity) > 10000) throw new AppError('invalid_quantity')
          if (!clean) throw new AppError('note_required')
          if (level.on_hand + quantity < 0) throw new AppError('insufficient_stock', `Only ${level.on_hand} ${item.name} in stock.`)
          delta = quantity
        }
        if (level.on_hand + delta > 100000) throw new AppError('invalid_quantity')
        const before = level.on_hand
        level.on_hand += delta
        level.updated_at = now()
        s.movements.push({
          id: s.nextId++, menu_item_id: menuItemId, item_name: item.name, kind, delta, on_hand_after: level.on_hand,
          unit_cost: kind === 'waste' ? s.costs.items[menuItemId] ?? null : null, order_id: null, note: clean || null,
          actor_name: me.name, created_at: now(),
        })
        audit(s, me.name, `stock.${kind}`, 'stock', menuItemId, item.name, {
          on_hand: [before, level.on_hand], ...(clean ? { note: [null, clean] as [unknown, unknown] } : {}),
        })
        return clone(level)
      })
    },

    async listStockMovements(menuItemId, limit = 200) {
      await delay(80)
      requireOwner()
      return clone(load().movements)
        .filter((m) => !menuItemId || m.menu_item_id === menuItemId)
        .sort((a, b) => b.id - a.id)
        .slice(0, limit)
    },

    async listIngredients() {
      await delay(80)
      requireOwner()
      return clone(load().ingredients).filter((i) => i.is_active).sort((a, b) => a.name.localeCompare(b.name))
    },

    async saveIngredient(input) {
      await delay()
      const me = requireOwner()
      return mutate((s) => {
        const name = cleanText(input.name)
        if (!name || name.length > 60) throw new AppError('invalid_name')
        const family: Record<string, string[]> = { g: ['g', 'kg'], ml: ['ml', 'L'], pcs: ['pcs', 'dozen'], packet: ['packet'] }
        if (!family[input.base_unit]?.includes(input.display_unit)) throw new AppError('invalid', 'Choose a unit.')
        if (!(input.low_at >= 0) || (input.opening ?? 0) < 0) throw new AppError('invalid_quantity')
        if (s.ingredients.some((i) => i.is_active && i.id !== input.id && i.name.toLowerCase() === name.toLowerCase())) throw new AppError('ingredient_exists')
        if (!input.id) {
          const opening = input.opening ?? 0
          const row: Ingredient = { id: uuid(), name, base_unit: input.base_unit, display_unit: input.display_unit, on_hand: opening, low_at: input.low_at, cost_per_unit: null, is_active: true, updated_at: now() }
          s.ingredients.push(row)
          s.ingredientMoves.push({ id: s.nextId++, ingredient_id: row.id, ingredient_name: name, kind: 'opening', delta: opening, on_hand_after: opening, unit_cost: null, amount: null, order_id: null, note: null, actor_name: me.name, created_at: now() })
          audit(s, me.name, 'ingredient.created', 'ingredient', row.id, name, { on_hand: [null, opening], display_unit: [null, row.display_unit] })
          return clone(row)
        }
        const row = s.ingredients.find((i) => i.id === input.id && i.is_active)
        if (!row) throw new AppError('ingredient_not_found')
        if (row.base_unit !== input.base_unit) throw new AppError('unit_family_locked')
        const before = clone(row)
        Object.assign(row, { name, display_unit: input.display_unit, low_at: input.low_at, updated_at: now() })
        audit(s, me.name, 'ingredient.updated', 'ingredient', row.id, name, diff(before, row, ['name', 'display_unit', 'low_at']))
        return clone(row)
      })
    },

    async archiveIngredient(id) {
      await delay()
      const me = requireOwner()
      mutate((s) => {
        const row = s.ingredients.find((i) => i.id === id && i.is_active)
        if (!row) throw new AppError('ingredient_not_found')
        row.is_active = false
        for (const k of Object.keys(s.recipes)) {
          s.recipes[k] = s.recipes[k].filter((l) => l.ingredient_id !== id)
          if (!s.recipes[k].length) delete s.recipes[k]
        }
        audit(s, me.name, 'ingredient.archived', 'ingredient', id, row.name, {})
      })
    },

    async adjustIngredient(id, kind, quantity, extra = {}) {
      await delay()
      const me = requireOwner()
      return mutate((s) => {
        if (!['purchase', 'usage', 'waste', 'count', 'correction'].includes(kind)) throw new AppError('invalid_request')
        if (!Number.isFinite(quantity)) throw new AppError('invalid_quantity')
        const note = extra.note ? cleanText(extra.note) : ''
        if (note.length > 140) throw new AppError('invalid_note')
        const row = s.ingredients.find((i) => i.id === id && i.is_active)
        if (!row) throw new AppError('ingredient_not_found')
        let delta: number
        let cost: number | null = null
        if (kind === 'purchase') {
          if (quantity <= 0) throw new AppError('invalid_quantity')
          if (extra.amount != null && (extra.amount < 0 || !Number.isInteger(extra.amount))) throw new AppError('invalid_amount')
          delta = quantity
          if (extra.amount) cost = extra.amount / quantity
        } else if (kind === 'usage' || kind === 'waste') {
          if (quantity <= 0) throw new AppError('invalid_quantity')
          delta = -quantity
          cost = row.cost_per_unit
        } else if (kind === 'count') {
          if (quantity < 0) throw new AppError('invalid_quantity')
          delta = quantity - row.on_hand
        } else {
          if (quantity === 0) throw new AppError('invalid_quantity')
          if (!note) throw new AppError('note_required')
          delta = quantity
        }
        const before = row.on_hand
        row.on_hand = Math.round((row.on_hand + delta) * 1000) / 1000
        if (kind === 'purchase' && cost !== null) row.cost_per_unit = cost
        row.updated_at = now()
        if (kind === 'purchase' && extra.addExpense && extra.amount) {
          const e: Expense = {
            id: uuid(), spent_on: cafeDate(), category: 'ingredients', amount: extra.amount,
            note: [`${row.name}${extra.label ? ` ${extra.label}` : ''}`, note || null].filter(Boolean).join(' · ').slice(0, 140),
            created_at: now(), updated_at: now(),
          }
          s.expenses.push(e)
          audit(s, me.name, 'expense.created', 'expense', e.id, e.category, diff(null, e, ['spent_on', 'category', 'amount', 'note']))
        }
        s.ingredientMoves.push({
          id: s.nextId++, ingredient_id: id, ingredient_name: row.name, kind, delta, on_hand_after: row.on_hand, unit_cost: cost,
          amount: kind === 'purchase' ? extra.amount ?? null : null, order_id: null, note: note || null, actor_name: me.name, created_at: now(),
        })
        audit(s, me.name, `ingredient.${kind}`, 'ingredient', id, row.name, {
          on_hand: [before, row.on_hand],
          ...(kind === 'purchase' && extra.amount != null ? { amount: [null, extra.amount] as [unknown, unknown] } : {}),
          ...(note ? { note: [null, note] as [unknown, unknown] } : {}),
        })
        return clone(row)
      })
    },

    async listIngredientMovements(id, limit = 200) {
      await delay(80)
      requireOwner()
      return clone(load().ingredientMoves)
        .filter((m) => !id || m.ingredient_id === id)
        .sort((a, b) => b.id - a.id)
        .slice(0, limit)
    },

    async getRecipes() {
      await delay(80)
      requireOwner()
      return clone(load().recipes)
    },

    async listAudit({ fromDay, toDay, beforeId, limit = 100 }) {
      await delay(80)
      requireOwner()
      const from = cafeDayStartIso(fromDay)
      const to = cafeDayStartIso(addDays(toDay, 1))
      return clone(load().audit)
        .filter((a) => a.at >= from && a.at < to && (!beforeId || a.id < beforeId))
        .sort((a, b) => b.id - a.id)
        .slice(0, limit)
    },
  }
}

const authListeners = new Set<() => void>()
