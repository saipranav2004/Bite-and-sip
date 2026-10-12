// Menu engineering (Kasavana & Smith): each item is judged on popularity
// (its share of units sold against 70 % of an equal share) and on profit per
// unit (against the menu's average). Four groups, each with a clear action.
import type { Costs, MenuItem, ProfitAndLossData } from './types'

export type MenuClass = 'star' | 'plowhorse' | 'puzzle' | 'dog' | 'unknown'

export const CLASS_INFO: Record<MenuClass, { label: string; hint: string; action: string }> = {
  star: { label: 'Stars', hint: 'Popular and profitable', action: 'Keep them exactly as they are. Show them first and never let them run out.' },
  plowhorse: { label: 'Popular, low profit', hint: 'Sell a lot, earn little each', action: 'Raise the price a little (₹5–10), or make them cheaper to prepare. A combo with a high-profit drink also helps.' },
  puzzle: { label: 'Profitable, rarely ordered', hint: 'Earn well, but few people order', action: 'Promote them: mark as Popular, add a better photo, put them on an offer or suggest them at the counter.' },
  dog: { label: 'Weak sellers', hint: 'Few orders and little profit', action: 'Replace them, rework the recipe, or remove them to keep the menu short.' },
  unknown: { label: 'Cost not set', hint: 'Add a cost to analyse', action: 'Set what each item costs to make (Menu → edit item) to see where it belongs.' },
}

export interface InsightRow {
  name: string
  menuItemId: string | null
  quantity: number
  sales: number
  /** Average profit per unit sold (₹), from the costs recorded at each sale. */
  marginPerUnit: number | null
  marginPct: number | null
  profit: number | null
  /** Share of all units sold. */
  mix: number
  klass: MenuClass
}

export interface Insights {
  rows: InsightRow[]
  /** Average profit per unit across costed items. */
  averageMargin: number | null
  /** Units an item must sell to count as popular. */
  popularAt: number
  totalUnits: number
}

export function menuEngineering(sold: ProfitAndLossData['items'], menu: MenuItem[], costs: Costs): Insights {
  const byName = new Map(menu.map((m) => [m.name, m]))
  const rows: Omit<InsightRow, 'klass' | 'mix'>[] = sold.map((s) => {
    const item = byName.get(s.name) ?? null
    const profit = s.cost === null ? null : s.sales - s.cost
    return {
      name: s.name,
      menuItemId: item?.id ?? null,
      quantity: s.quantity,
      sales: s.sales,
      profit,
      marginPerUnit: profit === null || s.quantity === 0 ? null : profit / s.quantity,
      marginPct: profit === null || s.sales === 0 ? null : profit / s.sales,
    }
  })
  // Items on the menu that sold nothing in the period count too.
  for (const m of menu) {
    if (!m.is_available || byName.get(m.name) !== m || sold.some((s) => s.name === m.name)) continue
    const cost = costs.items[m.id]
    rows.push({
      name: m.name, menuItemId: m.id, quantity: 0, sales: 0, profit: cost === undefined ? null : 0,
      marginPerUnit: cost === undefined ? null : m.price - cost,
      marginPct: cost === undefined ? null : (m.price - cost) / m.price,
    })
  }

  const totalUnits = rows.reduce((n, r) => n + r.quantity, 0)
  const popularAt = rows.length ? (totalUnits / rows.length) * 0.7 : 0
  const costed = rows.filter((r) => r.profit !== null && r.quantity > 0)
  const costedUnits = costed.reduce((n, r) => n + r.quantity, 0)
  const averageMargin = costedUnits > 0 ? costed.reduce((n, r) => n + (r.profit as number), 0) / costedUnits : null

  return {
    totalUnits,
    popularAt,
    averageMargin,
    rows: rows
      .map((r) => {
        const popular = r.quantity > 0 && r.quantity >= popularAt
        let klass: MenuClass = 'unknown'
        if (r.marginPerUnit !== null && averageMargin !== null) {
          const high = r.marginPerUnit >= averageMargin
          klass = popular ? (high ? 'star' : 'plowhorse') : high ? 'puzzle' : 'dog'
        }
        return { ...r, klass, mix: totalUnits ? r.quantity / totalUnits : 0 }
      })
      .sort((a, b) => b.quantity - a.quantity || b.sales - a.sales || a.name.localeCompare(b.name)),
  }
}
