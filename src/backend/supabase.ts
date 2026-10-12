import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js'
import { AppError, toAppError } from '../lib/errors'
import { bundledImage, isBundledImage } from '../lib/images'
import { cafeDayStartIso, addDays } from '../lib/format'
import type {
  AuditEntry, CafeSettings, CafeTable, Category, Costs, CustomerOrder, Expense, Ingredient, IngredientMovement, MenuItem, PlaceOrderInput, Recipes,
  ProfitAndLossData, SalesSummary, StaffMember, StaffOrder, StaffProfile, StockLevel, StockMovement,
} from '../lib/types'
import type { Backend, LiveStatus, MenuItemInput, PublicData, StatusChange } from './types'

const ORDER_COLUMNS =
  'id, order_no, customer_name, customer_phone, table_label, status, payment_method, payment_status, ' +
  'customer_reported_paid_at, payment_reference, total, item_count, cancel_reason, cancelled_by, created_at, ' +
  'updated_at, preparing_at, ready_at, completed_at, cancelled_at, paid_at, ' +
  'items:order_items(name, base_price, addons, unit_price, quantity, line_total, note)'

const IMAGE_BUCKET = 'menu-images'
const EXPENSE_COLUMNS = 'id, spent_on, category, amount, note, created_at, updated_at'
const STOCK_COLUMNS = 'menu_item_id, on_hand, low_at, updated_at'
const INGREDIENT_COLUMNS = 'id, name, base_unit, display_unit, on_hand, low_at, cost_per_unit, is_active, updated_at'

/** Postgres numeric may arrive as a string; the app always works with numbers. */
function toIngredient(r: Record<string, unknown>): Ingredient {
  return {
    ...(r as unknown as Ingredient),
    on_hand: Number(r.on_hand),
    low_at: Number(r.low_at),
    cost_per_unit: r.cost_per_unit === null || r.cost_per_unit === undefined ? null : Number(r.cost_per_unit),
  }
}

function unwrap<T>(res: { data: T; error: unknown }): T {
  if (res.error) throw toAppError(res.error)
  return res.data
}

function sortMenu(items: MenuItem[]) {
  for (const i of items) i.addons.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
  return items.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
}

function channelStatus(status: string): LiveStatus {
  if (status === 'SUBSCRIBED') return 'live'
  if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') return 'offline'
  return 'connecting'
}

export function createSupabaseBackend(url: string, key: string): Backend {
  const sb: SupabaseClient = createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'bitesip-staff-auth' },
  })

  async function staffProfileFor(userId: string, email: string | null): Promise<StaffProfile | null> {
    const { data, error } = await sb.from('staff').select('user_id, display_name, role, is_active').eq('user_id', userId).maybeSingle()
    if (error) throw toAppError(error)
    if (!data || !data.is_active) return null
    return { ...data, email }
  }

  const backend: Backend = {
    mode: 'supabase',

    async getPublicData(): Promise<PublicData> {
      const [settings, categories, items, tables, stock] = await Promise.all([
        sb.from('cafe_settings').select('cafe_name, is_open, closed_message, upi_id, upi_payee_name, updated_at').single(),
        sb.from('categories').select('id, name, sort_order').order('sort_order').order('name'),
        sb.from('menu_items').select('id, category_id, name, description, price, is_veg, is_available, is_popular, image_path, sort_order, addons(id, menu_item_id, name, price, is_available, sort_order)'),
        sb.from('cafe_tables').select('label, is_active').order('label'),
        sb.from('stock_levels').select(STOCK_COLUMNS),
      ])
      const tableList = unwrap(tables) as CafeTable[]
      return {
        settings: unwrap(settings) as CafeSettings,
        menu: { categories: unwrap(categories) as Category[], items: sortMenu(unwrap(items) as MenuItem[]) },
        tables: tableList.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
        stock: unwrap(stock) as StockLevel[],
      }
    },

    async placeOrder(input: PlaceOrderInput) {
      return unwrap(
        await sb.rpc('place_order', {
          p_client_request_id: input.client_request_id,
          p_access_token: input.access_token,
          p_customer_name: input.customer_name,
          p_customer_phone: input.customer_phone,
          p_payment_method: input.payment_method,
          p_table_label: input.table_label,
          p_items: input.items,
        }),
      ) as CustomerOrder
    },

    async getOrder(id, token) {
      return unwrap(await sb.rpc('get_order', { p_order_id: id, p_access_token: token })) as CustomerOrder
    },

    async getOrders(refs) {
      if (refs.length === 0) return []
      return unwrap(await sb.rpc('get_orders', { p_refs: refs.slice(0, 20) })) as CustomerOrder[]
    },

    async reportUpiPayment(id, token) {
      return unwrap(await sb.rpc('report_upi_payment', { p_order_id: id, p_access_token: token })) as CustomerOrder
    },

    async cancelMyOrder(id, token) {
      return unwrap(await sb.rpc('cancel_my_order', { p_order_id: id, p_access_token: token })) as CustomerOrder
    },

    watchOrder(trackKey, onChange, onStatus) {
      const channel: RealtimeChannel = sb
        .channel(`order:${trackKey}`, { config: { private: false } })
        .on('broadcast', { event: 'order_changed' }, () => onChange())
        .subscribe((status) => onStatus(channelStatus(status)))
      return () => {
        void sb.removeChannel(channel)
      }
    },

    imageUrl(path) {
      if (!path) return null
      if (isBundledImage(path)) return bundledImage(path)!.src
      return sb.storage.from(IMAGE_BUCKET).getPublicUrl(path).data.publicUrl
    },

    async getStaffSession() {
      const { data } = await sb.auth.getSession()
      const user = data.session?.user
      if (!user) return null
      return staffProfileFor(user.id, user.email ?? null)
    },

    async signIn(email, password) {
      const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password })
      if (error) {
        if (/invalid/i.test(error.message)) throw new AppError('invalid_credentials')
        throw toAppError(error)
      }
      const profile = await staffProfileFor(data.user.id, data.user.email ?? null)
      if (!profile) {
        await sb.auth.signOut()
        throw new AppError('not_staff')
      }
      return profile
    },

    async signOut() {
      await sb.auth.signOut()
    },

    onAuthChange(cb) {
      const { data } = sb.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') setTimeout(cb, 0)
      })
      return () => data.subscription.unsubscribe()
    },

    async listOrdersSince(sinceIso) {
      const res = await sb
        .from('orders')
        .select(ORDER_COLUMNS)
        .or(`status.in.(placed,preparing,ready),created_at.gte.${sinceIso}`)
        .order('created_at', { ascending: true })
        .limit(500)
      return unwrap(res) as unknown as StaffOrder[]
    },

    async listOrdersInRange(fromDay, toDay) {
      const res = await sb
        .from('orders')
        .select(ORDER_COLUMNS)
        .gte('created_at', cafeDayStartIso(fromDay))
        .lt('created_at', cafeDayStartIso(addDays(toDay, 1)))
        .order('created_at', { ascending: false })
        .limit(2000)
      return unwrap(res) as unknown as StaffOrder[]
    },

    async changeStatus(id, change: StatusChange) {
      const patch: Record<string, unknown> = { status: change.to }
      if (change.markPaid) patch.payment_status = 'paid'
      if (change.reason !== undefined) patch.cancel_reason = change.reason
      const res = await sb.from('orders').update(patch).eq('id', id).eq('status', change.from).select(ORDER_COLUMNS).maybeSingle()
      const row = unwrap(res) as unknown as StaffOrder | null
      if (!row) throw new AppError('conflict')
      return row
    },

    async setPayment(id, paid, reference) {
      const patch: Record<string, unknown> = { payment_status: paid ? 'paid' : 'unpaid' }
      if (paid) patch.payment_reference = reference?.trim() || null
      const res = await sb
        .from('orders')
        .update(patch)
        .eq('id', id)
        .eq('payment_status', paid ? 'unpaid' : 'paid')
        .select(ORDER_COLUMNS)
        .maybeSingle()
      const row = unwrap(res) as unknown as StaffOrder | null
      if (!row) throw new AppError('conflict')
      return row
    },

    watchOrders(onChange, onStatus) {
      const channel = sb
        .channel(`staff-orders-${crypto.randomUUID()}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (payload) => {
          const row = (payload.new ?? payload.old) as { id?: string } | null
          onChange(row?.id ?? null)
        })
        .subscribe((status) => onStatus(channelStatus(status)))
      return () => {
        void sb.removeChannel(channel)
      }
    },

    async saveMenuItem(input: MenuItemInput) {
      return unwrap(await sb.rpc('save_menu_item', { p_item: input })) as string
    },

    async deleteMenuItem(id) {
      const res = await sb.from('menu_items').delete().eq('id', id).select('id')
      if ((unwrap(res) ?? []).length === 0) throw new AppError('not_allowed')
    },

    async setItemAvailability(id, available) {
      const res = await sb.from('menu_items').update({ is_available: available }).eq('id', id).select('id')
      if ((unwrap(res) ?? []).length === 0) throw new AppError('not_allowed')
    },

    async setAddonAvailability(id, available) {
      const res = await sb.from('addons').update({ is_available: available }).eq('id', id).select('id')
      if ((unwrap(res) ?? []).length === 0) throw new AppError('not_allowed')
    },

    async uploadImage(file) {
      const ext = file.type === 'image/png' ? 'png' : file.type === 'image/jpeg' ? 'jpg' : 'webp'
      const path = `items/${crypto.randomUUID()}.${ext}`
      const { error } = await sb.storage.from(IMAGE_BUCKET).upload(path, file, { contentType: file.type, cacheControl: '31536000', upsert: false })
      if (error) throw toAppError(error)
      return path
    },

    async removeImage(path) {
      await sb.storage.from(IMAGE_BUCKET).remove([path])
    },

    async createCategory(name) {
      const { data: max } = await sb.from('categories').select('sort_order').order('sort_order', { ascending: false }).limit(1)
      const res = await sb
        .from('categories')
        .insert({ name: name.trim(), sort_order: (max?.[0]?.sort_order ?? 0) + 1 })
        .select('id, name, sort_order')
        .single()
      return unwrap(res) as Category
    },

    async updateCategory(id, patch) {
      const res = await sb.from('categories').update(patch).eq('id', id).select('id')
      if ((unwrap(res) ?? []).length === 0) throw new AppError('not_allowed')
    },

    async deleteCategory(id) {
      const res = await sb.from('categories').delete().eq('id', id).select('id')
      if ((unwrap(res) ?? []).length === 0) throw new AppError('not_allowed')
    },

    async updateSettings(patch) {
      const res = await sb
        .from('cafe_settings')
        .update(patch)
        .eq('id', true)
        .select('cafe_name, is_open, closed_message, upi_id, upi_payee_name, updated_at')
        .maybeSingle()
      const row = unwrap(res) as CafeSettings | null
      if (!row) throw new AppError('owner_only')
      return row
    },

    async addTables(labels) {
      const res = await sb.from('cafe_tables').upsert(labels.map((label) => ({ label, is_active: true })), { onConflict: 'label' })
      unwrap(res)
    },

    async setTableActive(label, active) {
      const res = await sb.from('cafe_tables').update({ is_active: active }).eq('label', label).select('label')
      if ((unwrap(res) ?? []).length === 0) throw new AppError('not_allowed')
    },

    async deleteTable(label) {
      const res = await sb.from('cafe_tables').delete().eq('label', label).select('label')
      if ((unwrap(res) ?? []).length === 0) throw new AppError('not_allowed')
    },

    async listStaff() {
      return unwrap(await sb.rpc('staff_directory')) as StaffMember[]
    },

    async updateStaff(userId, patch) {
      const res = await sb.from('staff').update(patch).eq('user_id', userId).select('user_id')
      if ((unwrap(res) ?? []).length === 0) throw new AppError('owner_only')
    },

    async changeOwnPassword(current, next) {
      const { data } = await sb.auth.getSession()
      const email = data.session?.user.email
      if (!email) throw new AppError('not_signed_in')
      if (next.length < 8 || next.length > 72) throw new AppError('weak_password')
      // Re-check the current password so an unattended, signed-in screen can't be used to take the account over.
      const check = await sb.auth.signInWithPassword({ email, password: current })
      if (check.error) throw new AppError('wrong_password')
      const { error } = await sb.auth.updateUser({ password: next })
      if (error) throw /password/i.test(error.message) ? new AppError('weak_password') : toAppError(error)
    },

    async salesSummary(fromDay, toDay) {
      return unwrap(await sb.rpc('sales_summary', { p_from: fromDay, p_to: toDay })) as SalesSummary
    },

    async getCosts() {
      const [items, addons] = await Promise.all([
        sb.from('menu_item_costs').select('menu_item_id, cost'),
        sb.from('addon_costs').select('addon_id, cost'),
      ])
      const costs: Costs = { items: {}, addons: {} }
      for (const r of unwrap(items) as { menu_item_id: string; cost: number }[]) costs.items[r.menu_item_id] = r.cost
      for (const r of unwrap(addons) as { addon_id: string; cost: number }[]) costs.addons[r.addon_id] = r.cost
      return costs
    },

    async profitAndLoss(fromDay, toDay) {
      return unwrap(await sb.rpc('profit_and_loss', { p_from: fromDay, p_to: toDay })) as ProfitAndLossData
    },

    async listExpenses(fromDay, toDay) {
      const res = await sb
        .from('expenses')
        .select(EXPENSE_COLUMNS)
        .gte('spent_on', fromDay)
        .lte('spent_on', toDay)
        .order('spent_on', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(1000)
      return unwrap(res) as Expense[]
    },

    async addExpense(input) {
      return unwrap(await sb.from('expenses').insert(input).select(EXPENSE_COLUMNS).single()) as Expense
    },

    async updateExpense(id, input) {
      const row = unwrap(await sb.from('expenses').update(input).eq('id', id).select(EXPENSE_COLUMNS).maybeSingle()) as Expense | null
      if (!row) throw new AppError('owner_only')
      return row
    },

    async deleteExpense(id) {
      const res = await sb.from('expenses').delete().eq('id', id).select('id')
      if ((unwrap(res) ?? []).length === 0) throw new AppError('owner_only')
    },

    async getStock() {
      return unwrap(await sb.from('stock_levels').select(STOCK_COLUMNS)) as StockLevel[]
    },

    async configureStock(menuItemId, track, lowAt, onHand) {
      unwrap(await sb.rpc('stock_configure', { p_menu_item_id: menuItemId, p_track: track, p_low_at: lowAt, p_on_hand: onHand }))
    },

    async adjustStock(menuItemId, kind, quantity, note) {
      const row = unwrap(
        await sb.rpc('stock_adjust', { p_menu_item_id: menuItemId, p_kind: kind, p_quantity: quantity, p_note: note }),
      ) as StockLevel & { tracked: boolean }
      return { menu_item_id: row.menu_item_id, on_hand: row.on_hand, low_at: row.low_at, updated_at: row.updated_at }
    },

    async listStockMovements(menuItemId, limit = 200) {
      let q = sb
        .from('stock_movements')
        .select('id, menu_item_id, item_name, kind, delta, on_hand_after, unit_cost, order_id, note, actor_name, created_at')
        .order('id', { ascending: false })
        .limit(limit)
      if (menuItemId) q = q.eq('menu_item_id', menuItemId)
      return unwrap(await q) as StockMovement[]
    },

    async listIngredients() {
      const res = await sb.from('ingredients').select(INGREDIENT_COLUMNS).eq('is_active', true).order('name')
      return (unwrap(res) as Record<string, unknown>[]).map(toIngredient)
    },

    async saveIngredient(input) {
      return toIngredient(unwrap(await sb.rpc('ingredient_save', { p: input })) as Record<string, unknown>)
    },

    async archiveIngredient(id) {
      unwrap(await sb.rpc('ingredient_archive', { p_id: id }))
    },

    async adjustIngredient(id, kind, quantity, extra = {}) {
      const row = unwrap(
        await sb.rpc('ingredient_adjust', {
          p_id: id, p_kind: kind, p_quantity: quantity, p_amount: extra.amount ?? null, p_note: extra.note ?? null,
          p_add_expense: extra.addExpense ?? false, p_label: extra.label ?? null,
        }),
      ) as Record<string, unknown>
      return toIngredient(row)
    },

    async listIngredientMovements(id, limit = 200) {
      let q = sb
        .from('ingredient_movements')
        .select('id, ingredient_id, ingredient_name, kind, delta, on_hand_after, unit_cost, amount, order_id, note, actor_name, created_at')
        .order('id', { ascending: false })
        .limit(limit)
      if (id) q = q.eq('ingredient_id', id)
      return (unwrap(await q) as Record<string, unknown>[]).map((r) => ({
        ...(r as unknown as IngredientMovement),
        delta: Number(r.delta),
        on_hand_after: Number(r.on_hand_after),
        unit_cost: r.unit_cost === null ? null : Number(r.unit_cost),
      }))
    },

    async getRecipes() {
      const rows = unwrap(await sb.from('recipe_lines').select('menu_item_id, ingredient_id, quantity')) as { menu_item_id: string; ingredient_id: string; quantity: number | string }[]
      const out: Recipes = {}
      for (const r of rows) (out[r.menu_item_id] ??= []).push({ ingredient_id: r.ingredient_id, quantity: Number(r.quantity) })
      return out
    },

    async listAudit({ fromDay, toDay, beforeId, limit = 100 }) {
      let q = sb
        .from('audit_log')
        .select('id, at, actor, actor_name, action, entity, entity_id, label, changes')
        .gte('at', cafeDayStartIso(fromDay))
        .lt('at', cafeDayStartIso(addDays(toDay, 1)))
        .order('id', { ascending: false })
        .limit(limit)
      if (beforeId) q = q.lt('id', beforeId)
      return unwrap(await q) as AuditEntry[]
    },
  }
  return backend
}

