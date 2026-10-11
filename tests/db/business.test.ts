// Costs, inventory, expenses, profit & loss and the audit log, against local Supabase.
import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cafeDate } from '../../src/lib/format'
import { ITEM, addon, admin, anonClient, env, placeOrder, setSettings, staffClient } from './helpers'

const SANDWICH = ITEM['Veg Sandwich']
const OMELETTE = ITEM['Bread Omelette']
const COLD_COFFEE = ITEM['Cold Coffee']

let anon: SupabaseClient
let owner: SupabaseClient
let kitchen: SupabaseClient
let intruder: SupabaseClient

beforeAll(async () => {
  anon = anonClient()
  owner = await staffClient('owner', 'Asha Owner')
  kitchen = await staffClient('kitchen', 'Ravi Kitchen')
  intruder = await staffClient(null, 'intruder')
  await setSettings({ is_open: true, upi_id: 'demo.bitesip@exampleupi' })
})

afterAll(async () => {
  await owner.rpc('stock_configure', { p_menu_item_id: OMELETTE.id, p_track: false, p_low_at: null, p_on_hand: null })
  await admin.from('menu_item_costs').delete().in('menu_item_id', [SANDWICH.id, COLD_COFFEE.id, OMELETTE.id])
})

async function order(items: unknown, extra: Parameters<typeof placeOrder>[1] = {}) {
  const res = await placeOrder(anon, { ...extra, p_items: items })
  if (res.error) throw new Error(`${res.error.message} ${res.error.details ?? ''}`)
  return { order: res.data as Record<string, any>, token: res.token }
}

async function itemPayload(name: string) {
  const { data, error } = await admin
    .from('menu_items')
    .select('id, category_id, name, description, price, is_veg, is_available, is_popular, image_path, addons(id, name, price, is_available, sort_order)')
    .eq('name', name)
    .single()
  if (error) throw error
  return { ...data, addons: [...data.addons].sort((a, b) => a.sort_order - b.sort_order) } as Record<string, any>
}

async function latestAudit(entityId: string, action?: string) {
  let q = owner.from('audit_log').select('*').eq('entity_id', entityId).order('id', { ascending: false }).limit(1)
  if (action) q = q.eq('action', action)
  const { data, error } = await q
  if (error) throw error
  return data[0] as Record<string, any> | undefined
}

async function pnl(from = cafeDate(), to = cafeDate()) {
  const { data, error } = await owner.rpc('profit_and_loss', { p_from: from, p_to: to })
  if (error) throw error
  return data as Record<string, any>
}

async function stock(id: string) {
  const { data } = await anon.from('stock_levels').select('on_hand, low_at').eq('menu_item_id', id).maybeSingle()
  return data as { on_hand: number; low_at: number } | null
}

describe('who can see business data', () => {
  it('hides costs, expenses, stock history and the audit log from the public and kitchen', async () => {
    for (const table of ['menu_item_costs', 'addon_costs', 'order_item_costs', 'expenses', 'stock_movements', 'audit_log']) {
      const pub = await anon.from(table).select('*').limit(1)
      expect(pub.error?.code, `anon ${table}`).toBe('42501')
      const k = await kitchen.from(table).select('*').limit(5)
      expect(k.error, `kitchen ${table}`).toBeNull()
      expect(k.data, `kitchen ${table}`).toEqual([])
      const i = await intruder.from(table).select('*').limit(5)
      expect(i.data ?? [], `intruder ${table}`).toEqual([])
    }
  })

  it('keeps stock counts public so the menu can show what is left', async () => {
    const res = await anon.from('stock_levels').select('menu_item_id, on_hand, low_at').limit(5)
    expect(res.error).toBeNull()
  })

  it('limits profit & loss and the staff directory to owners', async () => {
    for (const c of [anon, kitchen, intruder]) {
      const p = await c.rpc('profit_and_loss', { p_from: cafeDate(), p_to: cafeDate() })
      expect(p.error).not.toBeNull()
      const s = await c.rpc('staff_directory')
      expect(s.error).not.toBeNull()
    }
    const dir = await owner.rpc('staff_directory')
    expect(dir.error).toBeNull()
    const me = (dir.data as any[]).find((m) => m.display_name === 'Asha Owner')
    expect(me.email).toMatch(/@test\.bitesip$/)
  })

  it('stops kitchen from writing costs or expenses', async () => {
    const cost = await kitchen.from('menu_item_costs').insert({ menu_item_id: SANDWICH.id, cost: 1 })
    expect(cost.error).not.toBeNull()
    const exp = await kitchen.from('expenses').insert({ spent_on: cafeDate(), category: 'rent', amount: 1 })
    expect(exp.error).not.toBeNull()
  })
})

describe('item costs', () => {
  it('owner sets item and add-on costs through the menu editor', async () => {
    const item = await itemPayload(SANDWICH.name)
    item.cost = 18
    item.addons = item.addons.map((a: any) => ({ ...a, cost: a.name === 'Cheese slice' ? 7 : null }))
    const res = await owner.rpc('save_menu_item', { p_item: item })
    expect(res.error).toBeNull()
    const c = await owner.from('menu_item_costs').select('cost').eq('menu_item_id', SANDWICH.id).single()
    expect(c.data?.cost).toBe(18)
    const ac = await owner.from('addon_costs').select('cost').eq('addon_id', addon(SANDWICH, 'Cheese slice')).single()
    expect(ac.data?.cost).toBe(7)
  })

  it('leaves costs unchanged when the key is absent and removes them when null', async () => {
    const item = await itemPayload(SANDWICH.name)
    expect((await owner.rpc('save_menu_item', { p_item: item })).error).toBeNull()
    expect((await owner.from('menu_item_costs').select('cost').eq('menu_item_id', SANDWICH.id).single()).data?.cost).toBe(18)

    const coffee = await itemPayload(COLD_COFFEE.name)
    expect((await owner.rpc('save_menu_item', { p_item: { ...coffee, cost: 12 } })).error).toBeNull()
    expect((await owner.rpc('save_menu_item', { p_item: { ...coffee, cost: null } })).error).toBeNull()
    const gone = await owner.from('menu_item_costs').select('cost').eq('menu_item_id', COLD_COFFEE.id)
    expect(gone.data).toEqual([])
  })

  it('rejects invalid costs', async () => {
    const item = await itemPayload(SANDWICH.name)
    expect((await owner.rpc('save_menu_item', { p_item: { ...item, cost: 'free' } })).error).not.toBeNull()
    expect((await owner.rpc('save_menu_item', { p_item: { ...item, cost: -1 } })).error).not.toBeNull()
  })

  it('records the cost at the moment of sale; later changes do not rewrite history', async () => {
    const { order: o } = await order([{ menu_item_id: SANDWICH.id, quantity: 2, addon_ids: [addon(SANDWICH, 'Cheese slice')] }])
    const lines = await owner.from('order_items').select('id, unit_price').eq('order_id', o.id)
    const cost = await owner.from('order_item_costs').select('unit_cost').eq('order_item_id', lines.data![0].id).single()
    expect(cost.data?.unit_cost).toBe(25) // 18 + 7

    const item = await itemPayload(SANDWICH.name)
    expect((await owner.rpc('save_menu_item', { p_item: { ...item, cost: 30 } })).error).toBeNull()
    const again = await owner.from('order_item_costs').select('unit_cost').eq('order_item_id', lines.data![0].id).single()
    expect(again.data?.unit_cost).toBe(25)
    expect((await owner.rpc('save_menu_item', { p_item: { ...item, cost: 18 } })).error).toBeNull()
  })

  it('records no cost for items without one', async () => {
    const { order: o } = await order([{ menu_item_id: COLD_COFFEE.id, quantity: 1 }])
    const lines = await owner.from('order_items').select('id').eq('order_id', o.id)
    const cost = await owner.from('order_item_costs').select('unit_cost').eq('order_item_id', lines.data![0].id)
    expect(cost.data).toEqual([])
  })
})

describe('inventory', () => {
  it('only owners can start tracking; any staff can adjust', async () => {
    const k = await kitchen.rpc('stock_configure', { p_menu_item_id: OMELETTE.id, p_track: true, p_low_at: 3, p_on_hand: 5 })
    expect(k.error?.message).toBe('owner_only')
    const o = await owner.rpc('stock_configure', { p_menu_item_id: OMELETTE.id, p_track: true, p_low_at: 3, p_on_hand: 5 })
    expect(o.error).toBeNull()
    expect(await stock(OMELETTE.id)).toEqual({ on_hand: 5, low_at: 3 })

    const r = await kitchen.rpc('stock_adjust', { p_menu_item_id: OMELETTE.id, p_kind: 'restock', p_quantity: 3, p_note: 'Morning batch' })
    expect(r.error).toBeNull()
    expect((r.data as any).on_hand).toBe(8)
    const i = await intruder.rpc('stock_adjust', { p_menu_item_id: OMELETTE.id, p_kind: 'restock', p_quantity: 3, p_note: null })
    expect(i.error?.message).toBe('not_allowed')
    const a = await anon.rpc('stock_adjust', { p_menu_item_id: OMELETTE.id, p_kind: 'restock', p_quantity: 3, p_note: null })
    expect(a.error).not.toBeNull()
  })

  it('cannot be edited directly, only through the recorded functions', async () => {
    const res = await owner.from('stock_levels').update({ on_hand: 999 }).eq('menu_item_id', OMELETTE.id)
    expect(res.error).not.toBeNull()
    expect((await stock(OMELETTE.id))?.on_hand).toBe(8)
  })

  it('deducts stock per order across lines and refuses more than is left', async () => {
    await order([
      { menu_item_id: OMELETTE.id, quantity: 2 },
      { menu_item_id: OMELETTE.id, quantity: 1, note: 'no onion' },
    ])
    expect((await stock(OMELETTE.id))?.on_hand).toBe(5)

    const tooMany = await placeOrder(anon, { p_items: [{ menu_item_id: OMELETTE.id, quantity: 6 }] })
    expect(tooMany.error?.message).toBe('insufficient_stock')
    expect(tooMany.error?.details).toBe(OMELETTE.name)
    expect(tooMany.error?.hint).toBe('5')
    expect((await stock(OMELETTE.id))?.on_hand).toBe(5)
  })

  it('treats a tracked item at zero as sold out', async () => {
    const { order: o, token } = await order([{ menu_item_id: OMELETTE.id, quantity: 5 }])
    expect((await stock(OMELETTE.id))?.on_hand).toBe(0)
    const none = await placeOrder(anon, { p_items: [{ menu_item_id: OMELETTE.id, quantity: 1 }] })
    expect(none.error?.message).toBe('item_unavailable')

    // A customer cancelling puts the items back.
    const c = await anon.rpc('cancel_my_order', { p_order_id: o.id, p_access_token: token })
    expect(c.error).toBeNull()
    expect((await stock(OMELETTE.id))?.on_hand).toBe(5)
  })

  it('returns stock when staff cancel, and only once', async () => {
    const { order: o } = await order([{ menu_item_id: OMELETTE.id, quantity: 2 }])
    expect((await stock(OMELETTE.id))?.on_hand).toBe(3)
    const prep = await kitchen.from('orders').update({ status: 'preparing' }).eq('id', o.id)
    expect(prep.error).toBeNull()
    const cancel = await kitchen.from('orders').update({ status: 'cancelled', cancel_reason: 'Ran out of bread' }).eq('id', o.id)
    expect(cancel.error).toBeNull()
    expect((await stock(OMELETTE.id))?.on_hand).toBe(5)
    const hist = await owner.from('stock_movements').select('kind, delta, actor_name').eq('order_id', o.id).order('id')
    expect(hist.data).toEqual([
      { kind: 'sale', delta: -2, actor_name: 'Customer' },
      { kind: 'cancel_return', delta: 2, actor_name: 'Ravi Kitchen' },
    ])
  })

  it('validates waste, recounts and corrections', async () => {
    const tooMuch = await kitchen.rpc('stock_adjust', { p_menu_item_id: OMELETTE.id, p_kind: 'waste', p_quantity: 6, p_note: null })
    expect(tooMuch.error?.message).toBe('insufficient_stock')
    const noNote = await kitchen.rpc('stock_adjust', { p_menu_item_id: OMELETTE.id, p_kind: 'correction', p_quantity: -1, p_note: '  ' })
    expect(noNote.error?.message).toBe('note_required')
    const bad = await kitchen.rpc('stock_adjust', { p_menu_item_id: OMELETTE.id, p_kind: 'steal', p_quantity: 1, p_note: null })
    expect(bad.error?.message).toBe('invalid_request')
    const zero = await kitchen.rpc('stock_adjust', { p_menu_item_id: OMELETTE.id, p_kind: 'restock', p_quantity: 0, p_note: null })
    expect(zero.error?.message).toBe('invalid_quantity')

    const count = await kitchen.rpc('stock_adjust', { p_menu_item_id: OMELETTE.id, p_kind: 'count', p_quantity: 9, p_note: null })
    expect((count.data as any).on_hand).toBe(9)
    const fix = await owner.rpc('stock_adjust', { p_menu_item_id: OMELETTE.id, p_kind: 'correction', p_quantity: -2, p_note: 'Miscounted' })
    expect((fix.data as any).on_hand).toBe(7)
    const notTracked = await owner.rpc('stock_adjust', { p_menu_item_id: SANDWICH.id, p_kind: 'restock', p_quantity: 1, p_note: null })
    expect(notTracked.error?.message).toBe('stock_not_tracked')
  })

  it('values waste at the item cost and logs who did it', async () => {
    const item = await itemPayload(OMELETTE.name)
    expect((await owner.rpc('save_menu_item', { p_item: { ...item, cost: 14 } })).error).toBeNull()
    const before = await pnl()
    const w = await kitchen.rpc('stock_adjust', { p_menu_item_id: OMELETTE.id, p_kind: 'waste', p_quantity: 2, p_note: 'Dropped' })
    expect(w.error).toBeNull()
    const after = await pnl()
    expect(after.waste_cost - before.waste_cost).toBe(28)
    expect(after.waste_units - before.waste_units).toBe(2)

    const entry = await latestAudit(OMELETTE.id, 'stock.waste')
    expect(entry?.actor_name).toBe('Ravi Kitchen')
    expect(entry?.changes).toEqual({ on_hand: [7, 5], note: [null, 'Dropped'] })
  })

  it('stops tracking without deleting history', async () => {
    const off = await owner.rpc('stock_configure', { p_menu_item_id: OMELETTE.id, p_track: false, p_low_at: null, p_on_hand: null })
    expect(off.error).toBeNull()
    expect(await stock(OMELETTE.id)).toBeNull()
    const hist = await owner.from('stock_movements').select('id').eq('menu_item_id', OMELETTE.id)
    expect(hist.data!.length).toBeGreaterThan(5)
    // Untracked items sell freely again.
    await order([{ menu_item_id: OMELETTE.id, quantity: 3 }])
  })
})

describe('expenses', () => {
  it('owner records expenses; the author and timestamps cannot be forged', async () => {
    const forged = await owner
      .from('expenses')
      .insert({ spent_on: cafeDate(), category: 'gas', amount: 950, note: '  LPG   cylinder ', created_by: randomUUID() })
      .select()
    expect(forged.error).not.toBeNull() // created_by is not writable

    const ok = await owner.from('expenses').insert({ spent_on: cafeDate(), category: 'gas', amount: 950, note: '  LPG   cylinder ' }).select().single()
    expect(ok.error).toBeNull()
    expect(ok.data.note).toBe('LPG cylinder')
    const { data: me } = await owner.auth.getUser()
    expect(ok.data.created_by).toBe(me.user!.id)
  })

  it('rejects bad categories and amounts', async () => {
    expect((await owner.from('expenses').insert({ spent_on: cafeDate(), category: 'party', amount: 10 })).error).not.toBeNull()
    expect((await owner.from('expenses').insert({ spent_on: cafeDate(), category: 'rent', amount: 0 })).error).not.toBeNull()
  })
})

describe('profit & loss', () => {
  it('adds sales, food cost at sale time, uncosted sales and expenses correctly', async () => {
    const before = await pnl()
    await order([{ menu_item_id: SANDWICH.id, quantity: 3 }]) // 3 × ₹45 sales, 3 × ₹18 cost
    await order([{ menu_item_id: COLD_COFFEE.id, quantity: 1 }]) // no cost set
    const { order: cancelled, token } = await order([{ menu_item_id: SANDWICH.id, quantity: 1 }])
    await anon.rpc('cancel_my_order', { p_order_id: cancelled.id, p_access_token: token })
    await owner.from('expenses').insert({ spent_on: cafeDate(), category: 'packaging', amount: 300 })
    await owner.from('expenses').insert({ spent_on: cafeDate(), category: 'ingredients', amount: 1200 })
    const after = await pnl()

    expect(after.sales - before.sales).toBe(3 * SANDWICH.price + COLD_COFFEE.price)
    expect(after.food_cost - before.food_cost).toBe(54)
    expect(after.costed_sales - before.costed_sales).toBe(3 * SANDWICH.price)
    expect(after.uncosted_sales - before.uncosted_sales).toBe(COLD_COFFEE.price)
    const exp = (p: any, c: string) => p.expenses.find((e: any) => e.category === c)?.amount ?? 0
    expect(exp(after, 'packaging') - exp(before, 'packaging')).toBe(300)
    expect(exp(after, 'ingredients') - exp(before, 'ingredients')).toBe(1200)
    const sandwich = after.items.find((i: any) => i.name === SANDWICH.name)
    expect(sandwich.cost).not.toBeNull()
    const coffee = after.items.find((i: any) => i.name === COLD_COFFEE.name)
    expect(coffee.cost).toBeNull()
  })

  it('validates the range', async () => {
    const bad = await owner.rpc('profit_and_loss', { p_from: '2026-10-10', p_to: '2026-10-01' })
    expect(bad.error?.message).toBe('invalid_range')
    const long = await owner.rpc('profit_and_loss', { p_from: '2024-01-01', p_to: '2026-10-01' })
    expect(long.error?.message).toBe('invalid_range')
  })
})

describe('audit log', () => {
  it('records price changes with before/after and the person who made them', async () => {
    const item = await itemPayload(SANDWICH.name)
    expect((await owner.rpc('save_menu_item', { p_item: { ...item, price: item.price + 5 } })).error).toBeNull()
    const entry = await latestAudit(SANDWICH.id, 'menu_item.updated')
    expect(entry?.actor_name).toBe('Asha Owner')
    expect(entry?.label).toBe(SANDWICH.name)
    expect(entry?.changes).toEqual({ price: [item.price, item.price + 5] })
    expect((await owner.rpc('save_menu_item', { p_item: item })).error).toBeNull()
  })

  it('does not log saves that change nothing', async () => {
    const item = await itemPayload(SANDWICH.name)
    const before = await latestAudit(SANDWICH.id)
    expect((await owner.rpc('save_menu_item', { p_item: item })).error).toBeNull()
    expect((await latestAudit(SANDWICH.id))?.id).toBe(before?.id)
  })

  it('records kitchen sold-out switches, settings and payment decisions', async () => {
    await kitchen.from('menu_items').update({ is_available: false }).eq('id', COLD_COFFEE.id)
    await kitchen.from('menu_items').update({ is_available: true }).eq('id', COLD_COFFEE.id)
    const avail = await latestAudit(COLD_COFFEE.id, 'menu_item.updated')
    expect(avail?.actor_name).toBe('Ravi Kitchen')
    expect(avail?.changes).toEqual({ is_available: [false, true] })

    await owner.from('cafe_settings').update({ upi_id: 'changed.bitesip@exampleupi' }).eq('id', true)
    const upi = await latestAudit('true', 'settings.updated')
    expect(upi?.changes.upi_id).toEqual(['demo.bitesip@exampleupi', 'changed.bitesip@exampleupi'])
    await owner.from('cafe_settings').update({ upi_id: 'demo.bitesip@exampleupi' }).eq('id', true)

    const { order: o } = await order([{ menu_item_id: SANDWICH.id, quantity: 1 }], { p_payment_method: 'upi' })
    await kitchen.from('orders').update({ payment_status: 'paid', payment_reference: 'UTR123' }).eq('id', o.id)
    const paid = await latestAudit(o.id, 'order.marked_paid')
    expect(paid?.actor_name).toBe('Ravi Kitchen')
    expect(paid?.label).toContain(`BS-${o.order_no}`)
    expect(paid?.changes.payment_reference).toEqual([null, 'UTR123'])
  })

  it('attributes customer cancellations to the customer', async () => {
    const { order: o, token } = await order([{ menu_item_id: SANDWICH.id, quantity: 1 }])
    await anon.rpc('cancel_my_order', { p_order_id: o.id, p_access_token: token })
    const entry = await latestAudit(o.id, 'order.cancelled')
    expect(entry?.actor_name).toBe('Customer')
    expect(entry?.actor).toBeNull()
  })

  it('is append-only, even for owners and the secret key', async () => {
    const entry = await latestAudit(SANDWICH.id)
    const upd = await owner.from('audit_log').update({ actor_name: 'Someone else' }).eq('id', entry!.id)
    expect(upd.error).not.toBeNull()
    const del = await owner.from('audit_log').delete().eq('id', entry!.id)
    expect(del.error).not.toBeNull()
    const ins = await owner.from('audit_log').insert({ actor_name: 'x', action: 'x', entity: 'x' })
    expect(ins.error).not.toBeNull()
    const adminDel = await admin.from('audit_log').delete().eq('id', entry!.id)
    expect(adminDel.error?.message).toBe('audit_log_is_append_only')
    expect((await latestAudit(SANDWICH.id))?.id).toBe(entry!.id)
  })
})

describe('staff management', () => {
  it('lets owners add an existing account as staff, and nobody else', async () => {
    const email = `new-${randomUUID().slice(0, 8)}@test.bitesip`
    const { data } = await admin.auth.admin.createUser({ email, password: randomUUID(), email_confirm: true })
    const k = await kitchen.from('staff').insert({ user_id: data.user!.id, display_name: 'Sneaky', role: 'owner' })
    expect(k.error).not.toBeNull()
    const o = await owner.from('staff').insert({ user_id: data.user!.id, display_name: 'New Cook', role: 'kitchen' })
    expect(o.error).toBeNull()
    const entry = await latestAudit(data.user!.id, 'staff.created')
    expect(entry?.actor_name).toBe('Asha Owner')
  })
})

describe('staff accounts (staff-admin function)', () => {
  async function callStaffAdmin(client: SupabaseClient | null, body: unknown) {
    const token = client ? (await client.auth.getSession()).data.session?.access_token : undefined
    const res = await fetch(`${env.url}/functions/v1/staff-admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: env.publishableKey, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  const login = `cook${randomUUID().slice(0, 6)}`

  it('lets an owner create a login with just a username', async () => {
    const res = await callStaffAdmin(owner, { action: 'create', login, display_name: '  Meena   Cook ', role: 'kitchen', password: 'Kitchen.2026' })
    expect(res.status).toBe(200)
    expect(res.body.email).toBe(`${login}@bite.local`)

    const c = anonClient()
    const signIn = await c.auth.signInWithPassword({ email: `${login}@bite.local`, password: 'Kitchen.2026' })
    expect(signIn.error).toBeNull()
    const row = await c.from('staff').select('display_name, role').eq('user_id', signIn.data.user!.id).single()
    expect(row.data).toEqual({ display_name: 'Meena Cook', role: 'kitchen' })
    const entry = await latestAudit(signIn.data.user!.id, 'staff.created')
    expect(entry?.actor_name).toBe('Asha Owner')
  })

  it('rejects duplicates, weak passwords and bad input', async () => {
    expect((await callStaffAdmin(owner, { action: 'create', login, display_name: 'X', role: 'kitchen', password: 'Another.2026' })).body.error).toBe('login_taken')
    expect((await callStaffAdmin(owner, { action: 'create', login: 'shorty1', display_name: 'X', role: 'kitchen', password: 'short' })).body.error).toBe('weak_password')
    expect((await callStaffAdmin(owner, { action: 'create', login: 'bad name!', display_name: 'X', role: 'kitchen', password: 'Another.2026' })).body.error).toBe('invalid_login')
    expect((await callStaffAdmin(owner, { action: 'create', login: 'boss1', display_name: 'X', role: 'admin', password: 'Another.2026' })).body.error).toBe('invalid_role')
    expect((await callStaffAdmin(owner, { action: 'explode' })).body.error).toBe('invalid_request')
  })

  it('refuses kitchen staff, non-staff and anonymous callers', async () => {
    for (const c of [kitchen, intruder]) {
      const res = await callStaffAdmin(c, { action: 'create', login: 'sneaky1', display_name: 'S', role: 'owner', password: 'Sneaky.2026' })
      expect(res.status).toBe(403)
    }
    const res = await callStaffAdmin(null, { action: 'create', login: 'sneaky1', display_name: 'S', role: 'owner', password: 'Sneaky.2026' })
    expect(res.status).toBe(401)
    const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
    expect(data.users.some((u) => u.email === 'sneaky1@bite.local')).toBe(false)
  })

  it('resets a staff password and records who did it', async () => {
    const dir = await owner.rpc('staff_directory')
    const meena = (dir.data as any[]).find((m) => m.email === `${login}@bite.local`)
    const res = await callStaffAdmin(owner, { action: 'reset_password', user_id: meena.user_id, password: 'Fresh.Pass.2026' })
    expect(res.status).toBe(200)
    const c = anonClient()
    expect((await c.auth.signInWithPassword({ email: `${login}@bite.local`, password: 'Kitchen.2026' })).error).not.toBeNull()
    expect((await c.auth.signInWithPassword({ email: `${login}@bite.local`, password: 'Fresh.Pass.2026' })).error).toBeNull()
    const entry = await latestAudit(meena.user_id, 'staff.password_reset')
    expect(entry?.actor_name).toBe('Asha Owner')
    expect(entry?.label).toBe('Meena Cook')

    const k = await callStaffAdmin(kitchen, { action: 'reset_password', user_id: meena.user_id, password: 'Hijack.2026!' })
    expect(k.status).toBe(403)
  })
})
