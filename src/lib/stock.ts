// What students can order, given stock counts for tracked items.
import type { Menu, StockLevel } from './types'

/** Units left for a tracked item, or null when the item isn't stock-tracked. */
export function stockLeft(itemId: string, stock: StockLevel[]): number | null {
  const level = stock.find((s) => s.menu_item_id === itemId)
  return level ? Math.max(0, level.on_hand) : null
}

/** Shows tracked items at zero as sold out. The staff menu keeps the real switch value. */
export function applyStock(menu: Menu, stock: StockLevel[]): Menu {
  if (!stock.length) return menu
  return {
    ...menu,
    items: menu.items.map((i) => (i.is_available && stockLeft(i.id, stock) === 0 ? { ...i, is_available: false } : i)),
  }
}

/** "Only 3 left" once a tracked item reaches its low-stock level. */
export function lowStockNote(itemId: string, stock: StockLevel[]): string | null {
  const level = stock.find((s) => s.menu_item_id === itemId)
  if (!level || level.on_hand <= 0 || level.on_hand > Math.max(level.low_at, 0)) return null
  return `Only ${level.on_hand} left`
}
