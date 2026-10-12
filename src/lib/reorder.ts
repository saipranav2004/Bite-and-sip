// "Order again": turns a past order back into cart lines, using today's menu.
import { stockLeft } from './stock'
import type { CustomerOrder, MenuItem, StockLevel } from './types'

export interface ReorderPlan {
  lines: { menu_item_id: string; addon_ids: string[]; quantity: number; note: string }[]
  /** Lines that couldn't be added as they were (sold out, removed, add-on gone, less stock). */
  skipped: number
}

export function planReorder(order: Pick<CustomerOrder, 'items'>, menu: MenuItem[], stock: StockLevel[]): ReorderPlan {
  const byId = new Map(menu.map((m) => [m.id, m]))
  const used = new Map<string, number>()
  const plan: ReorderPlan = { lines: [], skipped: 0 }
  for (const l of order.items) {
    const item = l.menu_item_id ? byId.get(l.menu_item_id) : undefined
    if (!item || !item.is_available) {
      plan.skipped += 1
      continue
    }
    const wanted = l.addons.map((a) => a.id)
    const addonIds = wanted.filter((id) => item.addons.some((a) => a.id === id && a.is_available))
    const left = stockLeft(item.id, stock)
    const room = left === null ? l.quantity : Math.max(0, left - (used.get(item.id) ?? 0))
    const quantity = Math.min(l.quantity, room)
    if (quantity <= 0) {
      plan.skipped += 1
      continue
    }
    if (addonIds.length !== wanted.length || quantity < l.quantity) plan.skipped += 1
    used.set(item.id, (used.get(item.id) ?? 0) + quantity)
    plan.lines.push({ menu_item_id: item.id, addon_ids: addonIds, quantity, note: l.note ?? '' })
  }
  return plan
}
