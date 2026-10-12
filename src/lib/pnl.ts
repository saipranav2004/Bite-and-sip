// Profit & loss: the statement shown to the owner, and (for the demo backend)
// the same aggregation the database does in public.profit_and_loss.
import { addDays, cafeDate, cafeDayStartIso } from './format'
import type { Expense, ExpenseCategory, IngredientMovement, ProfitAndLossData, StaffOrder, StockMovement } from './types'

export const EXPENSE_CATEGORIES: { value: ExpenseCategory; label: string; hint: string }[] = [
  { value: 'ingredients', label: 'Ingredients & groceries', hint: 'Milk, vegetables, bread, Maggi packets…' },
  { value: 'salaries', label: 'Staff wages', hint: 'Salaries and daily wages' },
  { value: 'rent', label: 'Rent', hint: 'Counter or space rent' },
  { value: 'utilities', label: 'Electricity & water', hint: 'Power, water, internet' },
  { value: 'gas', label: 'Gas & fuel', hint: 'LPG cylinders' },
  { value: 'packaging', label: 'Packaging & disposables', hint: 'Cups, plates, tissues, bags' },
  { value: 'maintenance', label: 'Repairs & maintenance', hint: 'Equipment repairs, cleaning' },
  { value: 'marketing', label: 'Marketing', hint: 'Posters, offers' },
  { value: 'other', label: 'Other', hint: 'Anything else' },
]

export const expenseLabel = (c: string) => EXPENSE_CATEGORIES.find((x) => x.value === c)?.label ?? c

/**
 * How food cost is measured:
 *  - item_costs: quantity sold × the cost set on each item (recommended; gives per-item margins).
 *    Ingredient purchases are then shown only as a check, never subtracted a second time.
 *  - purchases: ingredient purchases logged as expenses are the food cost.
 *    Waste is already inside purchases, so it is not subtracted again either.
 */
export type FoodCostMethod = 'item_costs' | 'purchases'

export interface StatementLine {
  key: string
  label: string
  amount: number
  entries?: number
}

export interface Statement {
  method: FoodCostMethod
  sales: number
  foodCost: number
  /** Food cost is a lower bound because some sold items have no cost set. */
  foodCostIncomplete: boolean
  grossProfit: number
  grossMargin: number | null
  operating: StatementLine[]
  operatingTotal: number
  waste: number
  netProfit: number
  netMargin: number | null
  /** Ingredient purchases logged in the period. */
  purchases: number
  /** (food cost + wages) ÷ sales — restaurants aim for under ~60–65 %. */
  primeCost: number | null
}

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null)

export function buildStatement(d: ProfitAndLossData, method: FoodCostMethod): Statement {
  const purchases = d.expenses.find((e) => e.category === 'ingredients')?.amount ?? 0
  const foodCost = method === 'item_costs' ? d.food_cost : purchases
  const operating = d.expenses
    .filter((e) => e.category !== 'ingredients')
    .map((e) => ({ key: e.category, label: expenseLabel(e.category), amount: e.amount, entries: e.entries }))
    .sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label))
  const operatingTotal = operating.reduce((s, e) => s + e.amount, 0)
  const waste = method === 'item_costs' ? d.waste_cost : 0
  const grossProfit = d.sales - foodCost
  const netProfit = grossProfit - operatingTotal - waste
  const wages = d.expenses.find((e) => e.category === 'salaries')?.amount ?? 0
  return {
    method,
    sales: d.sales,
    foodCost,
    foodCostIncomplete: method === 'item_costs' && d.uncosted_sales > 0,
    grossProfit,
    grossMargin: ratio(grossProfit, d.sales),
    operating,
    operatingTotal,
    waste,
    netProfit,
    netMargin: ratio(netProfit, d.sales),
    purchases,
    primeCost: ratio(foodCost + wages, d.sales),
  }
}

/** Relative change, or null when there is nothing to compare against. */
export function change(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null
  return (current - previous) / Math.abs(previous)
}

/** The period of equal length immediately before [from, to]. */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1
  return { from: addDays(from, -days), to: addDays(from, -1) }
}

export interface CostedOrder extends StaffOrder {
  /** Cost per unit for each line at the moment of sale (null = no cost set). */
  line_costs: (number | null)[]
}

/** Mirrors public.profit_and_loss for the in-browser demo. */
export function computeProfitAndLoss(
  orders: CostedOrder[],
  expenses: Expense[],
  movements: StockMovement[],
  from: string,
  to: string,
  ingredientMovements: IngredientMovement[] = [],
): ProfitAndLossData {
  const start = cafeDayStartIso(from)
  const end = cafeDayStartIso(addDays(to, 1))
  const inRange = orders.filter((o) => o.created_at >= start && o.created_at < end)
  const live = inRange.filter((o) => o.status !== 'cancelled')
  const lines = live.flatMap((o) =>
    o.items.map((l, i) => ({ ...l, unit_cost: o.line_costs[i] ?? null, day: cafeDate(new Date(o.created_at)) })),
  )
  const exp = expenses.filter((e) => e.spent_on >= from && e.spent_on <= to)
  const waste = movements.filter((m) => m.kind === 'waste' && m.created_at >= start && m.created_at < end)
  const ingredientWaste = ingredientMovements.filter((m) => m.kind === 'waste' && m.unit_cost !== null && m.created_at >= start && m.created_at < end)
  const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0)

  const byCategory = new Map<ExpenseCategory, { amount: number; entries: number }>()
  for (const e of exp) {
    const c = byCategory.get(e.category) ?? { amount: 0, entries: 0 }
    c.amount += e.amount
    c.entries += 1
    byCategory.set(e.category, c)
  }

  const perItem = new Map<string, { quantity: number; sales: number; cost: number; uncosted: number }>()
  for (const l of lines) {
    const p = perItem.get(l.name) ?? { quantity: 0, sales: 0, cost: 0, uncosted: 0 }
    p.quantity += l.quantity
    p.sales += l.line_total
    if (l.unit_cost === null) p.uncosted += 1
    else p.cost += l.quantity * l.unit_cost
    perItem.set(l.name, p)
  }

  const days = new Map<string, { sales: number; food_cost: number; expenses: number }>()
  const day = (d: string) => {
    const v = days.get(d) ?? { sales: 0, food_cost: 0, expenses: 0 }
    days.set(d, v)
    return v
  }
  for (const l of lines) {
    const v = day(l.day)
    v.sales += l.line_total
    v.food_cost += l.unit_cost === null ? 0 : l.quantity * l.unit_cost
  }
  for (const e of exp) day(e.spent_on).expenses += e.amount

  const costed = lines.filter((l) => l.unit_cost !== null)
  const uncosted = lines.filter((l) => l.unit_cost === null)
  return {
    from,
    to,
    orders: live.length,
    sales: sum(live, (o) => o.total),
    outstanding: sum(live.filter((o) => o.payment_status === 'unpaid'), (o) => o.total),
    refunds_due: sum(inRange.filter((o) => o.status === 'cancelled' && o.payment_status === 'paid'), (o) => o.total),
    food_cost: sum(costed, (l) => l.quantity * (l.unit_cost as number)),
    costed_sales: sum(costed, (l) => l.line_total),
    uncosted_sales: sum(uncosted, (l) => l.line_total),
    uncosted_items: new Set(uncosted.map((l) => l.name)).size,
    waste_cost:
      sum(waste.filter((m) => m.unit_cost !== null), (m) => -m.delta * (m.unit_cost as number)) +
      Math.round(sum(ingredientWaste, (m) => -m.delta * (m.unit_cost as number))),
    waste_units: sum(waste, (m) => -m.delta),
    waste_uncosted_units: sum(waste.filter((m) => m.unit_cost === null), (m) => -m.delta),
    expenses: [...byCategory.entries()]
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category)),
    items: [...perItem.entries()]
      .map(([name, v]) => ({ name, quantity: v.quantity, sales: v.sales, cost: v.uncosted === 0 ? v.cost : null }))
      .sort((a, b) => b.sales - a.sales || a.name.localeCompare(b.name)),
    by_day: [...days.entries()].map(([d, v]) => ({ day: d, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
  }
}
