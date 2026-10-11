import { describe, expect, it } from 'vitest'
import { cafeDayStartIso } from './format'
import { buildStatement, change, computeProfitAndLoss, previousPeriod, type CostedOrder } from './pnl'
import type { Expense, ProfitAndLossData, StockMovement } from './types'

const base: ProfitAndLossData = {
  from: '2026-10-01', to: '2026-10-07', orders: 100, sales: 10_000, outstanding: 0, refunds_due: 0,
  food_cost: 3_500, costed_sales: 9_000, uncosted_sales: 1_000, uncosted_items: 1,
  waste_cost: 200, waste_units: 20, waste_uncosted_units: 0,
  expenses: [
    { category: 'ingredients', amount: 4_000, entries: 7 },
    { category: 'salaries', amount: 2_000, entries: 1 },
    { category: 'gas', amount: 500, entries: 1 },
  ],
  items: [], by_day: [],
}

describe('profit & loss statement', () => {
  it('uses item costs for food cost and never subtracts ingredient purchases a second time', () => {
    const s = buildStatement(base, 'item_costs')
    expect(s.foodCost).toBe(3_500)
    expect(s.grossProfit).toBe(6_500)
    expect(s.grossMargin).toBeCloseTo(0.65)
    expect(s.operating.map((l) => l.key)).toEqual(['salaries', 'gas'])
    expect(s.operatingTotal).toBe(2_500)
    expect(s.waste).toBe(200)
    expect(s.netProfit).toBe(10_000 - 3_500 - 2_500 - 200)
    expect(s.purchases).toBe(4_000)
    expect(s.foodCostIncomplete).toBe(true)
    expect(s.primeCost).toBeCloseTo((3_500 + 2_000) / 10_000)
  })

  it('can use ingredient purchases as food cost instead (waste is already inside purchases)', () => {
    const s = buildStatement(base, 'purchases')
    expect(s.foodCost).toBe(4_000)
    expect(s.waste).toBe(0)
    expect(s.netProfit).toBe(10_000 - 4_000 - 2_500)
    expect(s.foodCostIncomplete).toBe(false)
  })

  it('reports no margins when there were no sales', () => {
    const s = buildStatement({ ...base, sales: 0, food_cost: 0, uncosted_sales: 0 }, 'item_costs')
    expect(s.grossMargin).toBeNull()
    expect(s.netMargin).toBeNull()
    expect(s.netProfit).toBe(-2_700)
  })

  it('compares periods', () => {
    expect(change(120, 100)).toBeCloseTo(0.2)
    expect(change(-50, -100)).toBeCloseTo(0.5)
    expect(change(5, 0)).toBeNull()
    expect(change(0, 0)).toBe(0)
    expect(previousPeriod('2026-10-08', '2026-10-14')).toEqual({ from: '2026-10-01', to: '2026-10-07' })
    expect(previousPeriod('2026-10-01', '2026-10-01')).toEqual({ from: '2026-09-30', to: '2026-09-30' })
  })
})

describe('computeProfitAndLoss (demo mirror of the database function)', () => {
  const at = (day: string, h = 10) => new Date(new Date(cafeDayStartIso(day)).getTime() + h * 3600000).toISOString()
  const order = (o: Partial<CostedOrder>): CostedOrder => ({
    id: crypto.randomUUID(), order_no: 1, customer_name: 'A', customer_phone: '9876543210', table_label: null,
    status: 'completed', payment_method: 'cash', payment_status: 'paid', customer_reported_paid_at: null, payment_reference: null,
    total: 0, item_count: 0, cancel_reason: null, cancelled_by: null, created_at: at('2026-10-02'), updated_at: '', preparing_at: null,
    ready_at: null, completed_at: null, cancelled_at: null, paid_at: null, items: [], line_costs: [], ...o,
  })
  const line = (name: string, unit: number, qty: number) => ({ name, base_price: unit, addons: [], unit_price: unit, quantity: qty, line_total: unit * qty, note: null })

  it('matches the database rules', () => {
    const orders = [
      order({ total: 70, items: [line('Chai', 15, 2), line('Shake', 40, 1)], line_costs: [6, null] }),
      order({ total: 30, items: [line('Chai', 15, 2)], line_costs: [6], status: 'cancelled', payment_status: 'paid' }),
      order({ total: 15, items: [line('Chai', 15, 1)], line_costs: [5], status: 'ready', payment_status: 'unpaid' }),
      order({ total: 99, items: [line('Chai', 99, 1)], line_costs: [1], created_at: at('2026-10-09') }),
    ]
    const expenses: Expense[] = [
      { id: '1', spent_on: '2026-10-02', category: 'gas', amount: 1000, note: null, created_at: '', updated_at: '' },
      { id: '2', spent_on: '2026-10-03', category: 'gas', amount: 50, note: null, created_at: '', updated_at: '' },
      { id: '3', spent_on: '2026-10-20', category: 'rent', amount: 9, note: null, created_at: '', updated_at: '' },
    ]
    const movements: StockMovement[] = [
      { id: 1, menu_item_id: 'x', item_name: 'Chai', kind: 'waste', delta: -3, on_hand_after: 0, unit_cost: 6, order_id: null, note: null, actor_name: null, created_at: at('2026-10-03') },
      { id: 2, menu_item_id: 'x', item_name: 'Chai', kind: 'waste', delta: -2, on_hand_after: 0, unit_cost: null, order_id: null, note: null, actor_name: null, created_at: at('2026-10-03') },
    ]
    const d = computeProfitAndLoss(orders, expenses, movements, '2026-10-01', '2026-10-07')
    expect(d.orders).toBe(2)
    expect(d.sales).toBe(85)
    expect(d.outstanding).toBe(15)
    expect(d.refunds_due).toBe(30)
    expect(d.food_cost).toBe(2 * 6 + 5)
    expect(d.costed_sales).toBe(45)
    expect(d.uncosted_sales).toBe(40)
    expect(d.uncosted_items).toBe(1)
    expect(d.waste_cost).toBe(18)
    expect(d.waste_units).toBe(5)
    expect(d.waste_uncosted_units).toBe(2)
    expect(d.expenses).toEqual([{ category: 'gas', amount: 1050, entries: 2 }])
    expect(d.items).toEqual([
      { name: 'Chai', quantity: 3, sales: 45, cost: 17 },
      { name: 'Shake', quantity: 1, sales: 40, cost: null },
    ])
    expect(d.by_day).toEqual([
      { day: '2026-10-02', sales: 85, food_cost: 17, expenses: 1000 },
      { day: '2026-10-03', sales: 0, food_cost: 0, expenses: 50 },
    ])
  })
})

describe('stock for students', async () => {
  const { applyStock, lowStockNote, stockLeft } = await import('./stock')
  const item = (id: string, is_available = true) => ({
    id, category_id: 'c', name: id, description: '', price: 10, is_veg: true, is_available, is_popular: false, image_path: null, sort_order: 1, addons: [],
  })
  const stock = [
    { menu_item_id: 'a', on_hand: 0, low_at: 3, updated_at: '' },
    { menu_item_id: 'b', on_hand: 2, low_at: 3, updated_at: '' },
    { menu_item_id: 'c', on_hand: 9, low_at: 3, updated_at: '' },
  ]
  it('sells out tracked items at zero and leaves the rest alone', () => {
    const menu = applyStock({ categories: [], items: [item('a'), item('b'), item('c'), item('d'), item('e', false)] }, stock)
    expect(menu.items.map((i) => i.is_available)).toEqual([false, true, true, true, false])
    expect(stockLeft('b', stock)).toBe(2)
    expect(stockLeft('d', stock)).toBeNull()
    expect(lowStockNote('b', stock)).toBe('Only 2 left')
    expect(lowStockNote('c', stock)).toBeNull()
    expect(lowStockNote('a', stock)).toBeNull()
  })
})
