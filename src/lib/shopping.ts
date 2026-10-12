// Shopping list and the usage check, from ingredient stock and history.
import type { Ingredient, IngredientUsage, IngredientUnit } from './types'

export const USAGE_WINDOW_DAYS = 14

/** Average used per day (base units) over the window, or since the ingredient was added. */
export function dailyUse(u: IngredientUsage | undefined, now = Date.now(), windowDays = USAGE_WINDOW_DAYS): number {
  if (!u) return 0
  const consumed = u.sold + u.used + u.wasted
  if (consumed <= 0) return 0
  const since = u.first_movement_at ? (now - new Date(u.first_movement_at).getTime()) / 86400000 : windowDays
  const days = Math.min(windowDays, Math.max(1, since))
  return consumed / days
}

/** Round a purchase up to what you'd actually buy in that unit. */
export function roundPurchase(baseQty: number, display: IngredientUnit): number {
  if (baseQty <= 0) return 0
  const step = display === 'kg' || display === 'L' ? 500 : display === 'g' || display === 'ml' ? (baseQty >= 1000 ? 250 : 50) : display === 'dozen' ? 12 : 1
  return Math.ceil(baseQty / step - 1e-9) * step
}

export interface ShoppingRow {
  ingredient: Ingredient
  /** Base units per day. */
  perDay: number
  daysLeft: number | null
  /** Base units to buy (rounded up). */
  buy: number
  estimatedCost: number | null
  reason: 'below_low' | 'runs_out'
}

/**
 * What to buy so stock lasts `coverDays` and still ends at the low-stock level.
 * Items with no usage history are listed only when already at or below their low level.
 */
export function shoppingList(ingredients: Ingredient[], usage: IngredientUsage[], coverDays: number, now = Date.now()): ShoppingRow[] {
  const byId = new Map(usage.map((u) => [u.ingredient_id, u]))
  const rows: ShoppingRow[] = []
  for (const ing of ingredients) {
    const perDay = dailyUse(byId.get(ing.id), now)
    const onHand = Math.max(0, ing.on_hand)
    const target = perDay > 0 ? perDay * coverDays + ing.low_at : ing.low_at > 0 ? ing.low_at * 2 : 0
    const below = ing.low_at > 0 && ing.on_hand <= ing.low_at
    if (target <= onHand) continue
    const buy = roundPurchase(target - onHand, ing.display_unit)
    if (buy <= 0) continue
    rows.push({
      ingredient: ing,
      perDay,
      daysLeft: perDay > 0 ? onHand / perDay : null,
      buy,
      estimatedCost: ing.cost_per_unit === null ? null : Math.round(buy * ing.cost_per_unit),
      reason: below ? 'below_low' : 'runs_out',
    })
  }
  return rows.sort((a, b) => (a.daysLeft ?? -1) - (b.daysLeft ?? -1) || a.ingredient.name.localeCompare(b.ingredient.name))
}

export interface UsageCheckRow {
  ingredient: Ingredient
  /** What sales (recipes), logged usage and waste account for. */
  expected: number
  /** Expected adjusted by what counts found. */
  actual: number
  /** actual − expected (positive = more used than recorded). */
  gap: number
  /** gap ÷ expected. */
  gapPct: number | null
  /** ₹ value of the gap at the latest price. */
  gapValue: number | null
  counted: boolean
  status: 'ok' | 'watch' | 'high' | 'surplus' | 'not_counted'
}

export function usageCheck(ingredients: Ingredient[], usage: IngredientUsage[]): UsageCheckRow[] {
  const byId = new Map(usage.map((u) => [u.ingredient_id, u]))
  return ingredients
    .map((ing) => {
      const u = byId.get(ing.id)
      const expected = u ? u.sold + u.used + u.wasted : 0
      const gap = u ? -u.count_difference : 0
      const counted = !!u && u.counts > 0
      const gapPct = expected > 0 ? gap / expected : null
      let status: UsageCheckRow['status'] = 'not_counted'
      if (counted) {
        if (gap < 0) status = Math.abs(gapPct ?? 1) > 0.05 ? 'surplus' : 'ok'
        else if (gapPct === null) status = gap > 0 ? 'high' : 'ok'
        else status = gapPct > 0.15 ? 'high' : gapPct > 0.05 ? 'watch' : 'ok'
      }
      return {
        ingredient: ing,
        expected,
        actual: expected + gap,
        gap,
        gapPct,
        gapValue: ing.cost_per_unit === null ? null : Math.round(gap * ing.cost_per_unit),
        counted,
        status,
      }
    })
    .filter((r) => r.expected > 0 || r.counted)
    .sort((a, b) => (b.gapValue ?? 0) - (a.gapValue ?? 0) || a.ingredient.name.localeCompare(b.ingredient.name))
}
