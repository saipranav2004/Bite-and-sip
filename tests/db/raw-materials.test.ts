// Raw materials: ingredients, purchases, recipes and automatic deduction, against local Supabase.
import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cafeDate } from '../../src/lib/format'
import { ITEM, admin, anonClient, placeOrder, setSettings, staffClient } from './helpers'

const COFFEE = ITEM['Filter Coffee'] // ₹20, no add-ons
const tag = randomUUID().slice(0, 6)

let anon: SupabaseClient
let owner: SupabaseClient
let kitchen: SupabaseClient
let milk: Record<string, any>
let sugar: Record<string, any>

beforeAll(async () => {
  anon = anonClient()
  owner = await staffClient('owner', 'Raw Owner')
  kitchen = await staffClient('kitchen', 'Raw Kitchen')
  await setSettings({ is_open: true, upi_id: 'demo.bitesip@exampleupi' })
})

afterAll(async () => {
  await admin.from('recipe_lines').delete().eq('menu_item_id', COFFEE.id)
})

async function save(client: SupabaseClient, p: Record<string, unknown>) {
  return client.rpc('ingredient_save', { p })
}
async function adjust(id: string, kind: string, quantity: number, extra: { amount?: number; note?: string; addExpense?: boolean; label?: string } = {}) {
  return owner.rpc('ingredient_adjust', {
    p_id: id, p_kind: kind, p_quantity: quantity, p_amount: extra.amount ?? null, p_note: extra.note ?? null,
    p_add_expense: extra.addExpense ?? false, p_label: extra.label ?? null,
  })
}
async function onHand(id: string) {
  const { data } = await owner.from('ingredients').select('on_hand').eq('id', id).single()
  return Number(data!.on_hand)
}
async function coffeePayload(recipe?: unknown) {
  const { data } = await admin.from('menu_items')
    .select('id, category_id, name, description, price, is_veg, is_available, is_popular, image_path, addons(id, name, price, is_available)')
    .eq('id', COFFEE.id).single()
  return { ...data, ...(recipe === undefined ? {} : { recipe }) }
}
async function order(qty: number, extra: Parameters<typeof placeOrder>[1] = {}) {
  const res = await placeOrder(anon, { ...extra, p_items: [{ menu_item_id: COFFEE.id, quantity: qty }] })
  if (res.error) throw new Error(res.error.message)
  return { order: res.data as Record<string, any>, token: res.token }
}

describe('access', () => {
  it('is owner-only', async () => {
    for (const t of ['ingredients', 'ingredient_movements', 'recipe_lines']) {
      expect((await anon.from(t).select('*').limit(1)).error?.code, t).toBe('42501')
      expect((await kitchen.from(t).select('*').limit(5)).data, t).toEqual([])
    }
    expect((await save(kitchen, { name: 'X', base_unit: 'g', display_unit: 'kg' })).error?.message).toBe('owner_only')
    expect((await anon.rpc('ingredient_save', { p: { name: 'X', base_unit: 'g', display_unit: 'kg' } })).error).not.toBeNull()
    const direct = await owner.from('ingredients').insert({ name: 'Sneaky', base_unit: 'g', display_unit: 'g' })
    expect(direct.error).not.toBeNull()
  })
})

describe('ingredients', () => {
  it('creates ingredients with any name and a unit, plus opening stock', async () => {
    const m = await save(owner, { name: `  Milk   ${tag} `, base_unit: 'ml', display_unit: 'L', low_at: 1000, opening: 2000 })
    expect(m.error).toBeNull()
    milk = m.data as Record<string, any>
    expect(milk.name).toBe(`Milk ${tag}`)
    expect(Number(milk.on_hand)).toBe(2000)
    const s = await save(owner, { name: `Sugar ${tag}`, base_unit: 'g', display_unit: 'kg', opening: 5000 })
    expect(s.error).toBeNull()
    sugar = s.data as Record<string, any>
    const hist = await owner.from('ingredient_movements').select('kind, delta').eq('ingredient_id', milk.id)
    expect(hist.data).toEqual([{ kind: 'opening', delta: 2000 }])
  })

  it('rejects duplicate names (any case), mismatched units and unit-family changes', async () => {
    expect((await save(owner, { name: `MILK ${tag}`, base_unit: 'ml', display_unit: 'ml' })).error?.message).toBe('ingredient_exists')
    expect((await save(owner, { name: `Odd ${tag}`, base_unit: 'g', display_unit: 'L' })).error).not.toBeNull()
    expect((await save(owner, { name: `Odd ${tag}`, base_unit: 'kg', display_unit: 'kg' })).error).not.toBeNull()
    expect((await save(owner, { id: milk.id, name: milk.name, base_unit: 'g', display_unit: 'kg' })).error?.message).toBe('unit_family_locked')
    const ok = await save(owner, { id: milk.id, name: milk.name, base_unit: 'ml', display_unit: 'ml', low_at: 500 })
    expect(ok.error).toBeNull()
    expect((ok.data as any).display_unit).toBe('ml')
  })

  it('records a purchase, its unit cost, and (optionally) the expense', async () => {
    const res = await adjust(milk.id, 'purchase', 5000, { amount: 300, addExpense: true, label: '5 L', note: 'Nandini' })
    expect(res.error).toBeNull()
    expect(Number((res.data as any).on_hand)).toBe(7000)
    expect(Number((res.data as any).cost_per_unit)).toBeCloseTo(0.06, 6)
    const mv = await owner.from('ingredient_movements').select('kind, amount, expense_id').eq('ingredient_id', milk.id).eq('kind', 'purchase').single()
    expect(mv.data!.amount).toBe(300)
    const exp = await owner.from('expenses').select('category, amount, note, spent_on').eq('id', mv.data!.expense_id).single()
    expect(exp.data).toEqual({ category: 'ingredients', amount: 300, note: `Milk ${tag} 5 L · Nandini`, spent_on: cafeDate() })

    const noExp = await adjust(sugar.id, 'purchase', 1000, { amount: 45, addExpense: false })
    expect(noExp.error).toBeNull()
    const mv2 = await owner.from('ingredient_movements').select('expense_id').eq('ingredient_id', sugar.id).eq('kind', 'purchase').single()
    expect(mv2.data!.expense_id).toBeNull()
  })

  it('validates usage, waste, counts and corrections', async () => {
    expect((await adjust(milk.id, 'usage', 0)).error?.message).toBe('invalid_quantity')
    expect((await adjust(milk.id, 'count', -1)).error?.message).toBe('invalid_quantity')
    expect((await adjust(milk.id, 'correction', -5)).error?.message).toBe('note_required')
    expect((await adjust(milk.id, 'teleport', 5)).error?.message).toBe('invalid_request')
    expect(Number(((await adjust(milk.id, 'usage', 500)).data as any).on_hand)).toBe(6500)
    expect(Number(((await adjust(milk.id, 'count', 6400)).data as any).on_hand)).toBe(6400)
    expect(Number(((await adjust(milk.id, 'correction', 100, { note: 'Miscounted' })).data as any).on_hand)).toBe(6500)
    const kitchenTry = await kitchen.rpc('ingredient_adjust', { p_id: milk.id, p_kind: 'usage', p_quantity: 1, p_amount: null, p_note: null, p_add_expense: false, p_label: null })
    expect(kitchenTry.error?.message).toBe('owner_only')
  })

  it('values wasted ingredients at cost in profit & loss', async () => {
    const before = (await owner.rpc('profit_and_loss', { p_from: cafeDate(), p_to: cafeDate() })).data as any
    expect((await adjust(milk.id, 'waste', 1000, { note: 'Spoiled' })).error).toBeNull() // 1000 ml × ₹0.06
    const after = (await owner.rpc('profit_and_loss', { p_from: cafeDate(), p_to: cafeDate() })).data as any
    expect(after.waste_cost - before.waste_cost).toBe(60)
    expect(await onHand(milk.id)).toBe(5500)
  })
})

describe('recipes and automatic deduction', () => {
  it('saves a recipe through the menu editor and rejects bad lines', async () => {
    const bad = await owner.rpc('save_menu_item', { p_item: await coffeePayload([{ ingredient_id: randomUUID(), quantity: 5 }]) })
    expect(bad.error?.message).toBe('invalid_recipe')
    const zero = await owner.rpc('save_menu_item', { p_item: await coffeePayload([{ ingredient_id: milk.id, quantity: 0 }]) })
    expect(zero.error?.message).toBe('invalid_recipe')
    const ok = await owner.rpc('save_menu_item', {
      p_item: await coffeePayload([{ ingredient_id: milk.id, quantity: 120 }, { ingredient_id: sugar.id, quantity: 8 }]),
    })
    expect(ok.error).toBeNull()
    const lines = await owner.from('recipe_lines').select('ingredient_id, quantity').eq('menu_item_id', COFFEE.id)
    expect(lines.data!.length).toBe(2)
    const kitchenEdit = await kitchen.from('recipe_lines').update({ quantity: 1 }).eq('menu_item_id', COFFEE.id).select()
    expect(kitchenEdit.data ?? []).toEqual([])
  })

  it('leaves the recipe alone when the key is absent', async () => {
    expect((await owner.rpc('save_menu_item', { p_item: await coffeePayload() })).error).toBeNull()
    expect((await owner.from('recipe_lines').select('quantity').eq('menu_item_id', COFFEE.id)).data!.length).toBe(2)
  })

  it('deducts ingredients for every unit sold, once per order', async () => {
    const m0 = await onHand(milk.id)
    const s0 = await onHand(sugar.id)
    const res = await placeOrder(anon, {
      p_items: [
        { menu_item_id: COFFEE.id, quantity: 2 },
        { menu_item_id: COFFEE.id, quantity: 1, note: 'strong' },
      ],
    })
    expect(res.error).toBeNull()
    expect(await onHand(milk.id)).toBe(m0 - 360)
    expect(await onHand(sugar.id)).toBe(s0 - 24)
    const mv = await owner.from('ingredient_movements').select('kind, delta, actor_name').eq('order_id', (res.data as any).id).eq('ingredient_id', milk.id)
    expect(mv.data).toEqual([{ kind: 'sale', delta: -360, actor_name: 'Customer' }])
  })

  it('puts ingredients back when an order is cancelled, exactly once', async () => {
    const m0 = await onHand(milk.id)
    const { order: o, token } = await order(1)
    expect(await onHand(milk.id)).toBe(m0 - 120)
    expect((await anon.rpc('cancel_my_order', { p_order_id: o.id, p_access_token: token })).error).toBeNull()
    expect(await onHand(milk.id)).toBe(m0)
    // A second cancel attempt changes nothing.
    await anon.rpc('cancel_my_order', { p_order_id: o.id, p_access_token: token })
    expect(await onHand(milk.id)).toBe(m0)
  })

  it('never blocks a sale when an ingredient runs short', async () => {
    expect((await adjust(milk.id, 'count', 100)).error).toBeNull()
    const { order: o } = await order(2)
    expect(o.status).toBe('placed')
    expect(await onHand(milk.id)).toBe(-140)
  })

  it('records recipe changes in the audit log', async () => {
    expect((await owner.rpc('save_menu_item', { p_item: await coffeePayload([{ ingredient_id: milk.id, quantity: 150 }]) })).error).toBeNull()
    const log = await owner.from('audit_log').select('action, label, changes').eq('entity', 'recipe').eq('entity_id', COFFEE.id).order('id', { ascending: false }).limit(2)
    const actions = log.data!.map((r) => r.action).sort()
    expect(actions).toEqual(['recipe.changed', 'recipe.removed'])
    const changed = log.data!.find((r) => r.action === 'recipe.changed')!
    expect(changed.label).toBe(`${COFFEE.name} › Milk ${tag}`)
    expect(changed.changes.quantity.map(Number)).toEqual([120, 150])
  })

  it('archiving an ingredient drops it from recipes and frees its name; history stays', async () => {
    expect((await owner.rpc('ingredient_archive', { p_id: sugar.id })).error).toBeNull()
    expect((await owner.rpc('save_menu_item', { p_item: await coffeePayload([{ ingredient_id: sugar.id, quantity: 5 }]) })).error?.message).toBe('invalid_recipe')
    expect((await save(owner, { name: `Sugar ${tag}`, base_unit: 'g', display_unit: 'g' })).error).toBeNull()
    expect((await owner.from('ingredient_movements').select('id').eq('ingredient_id', sugar.id)).data!.length).toBeGreaterThan(1)
    expect((await owner.rpc('save_menu_item', { p_item: await coffeePayload([]) })).error).toBeNull()
    expect((await owner.from('recipe_lines').select('*').eq('menu_item_id', COFFEE.id)).data).toEqual([])
  })
})
