import { bestOffer, cafeClock, discountFor, type CafeClock } from './offers'
import type { CartLine, MenuItem, Offer } from './types'

export const MAX_QTY_PER_LINE = 20
export const MAX_LINES = 30
export const MAX_UNITS = 50

export type LineIssue = 'item_missing' | 'item_unavailable' | 'addon_unavailable'

export interface PricedLine {
  line: CartLine
  item: MenuItem | null
  addons: { id: string; name: string; price: number }[]
  /** Offer discount per unit (₹). */
  discount: number
  offerTitle: string | null
  unitPrice: number
  lineTotal: number
  issue: LineIssue | null
}

export interface PricedCart {
  lines: PricedLine[]
  total: number
  units: number
  /** What offers take off the total. */
  savings: number
  hasIssues: boolean
}

/** A cart line is identified by item + chosen add-ons + note, so identical choices merge. */
export function lineKey(menuItemId: string, addonIds: string[], note: string) {
  return [menuItemId, [...addonIds].sort().join(','), note.trim().toLowerCase()].join('|')
}

/** Price of one unit: base price plus the selected add-ons. */
export function unitPrice(item: Pick<MenuItem, 'price' | 'addons'>, addonIds: string[]) {
  const chosen = new Set(addonIds)
  return item.price + item.addons.filter((a) => chosen.has(a.id)).reduce((sum, a) => sum + a.price, 0)
}

/** An item's price after the best live offer: { price, was, offer }. */
export function offerPrice(item: Pick<MenuItem, 'id' | 'price'>, offers: Offer[], clock: CafeClock = cafeClock()) {
  const offer = bestOffer(item.id, offers, clock)
  const discount = offer ? discountFor(item.price, offer.percent_off) : 0
  return { price: item.price - discount, was: discount > 0 ? item.price : null, offer: discount > 0 ? offer : null, discount }
}

/**
 * Prices the cart against the live menu and offers. Display only: the database
 * recomputes every price when the order is placed and never trusts these numbers
 * (it refuses the order if its total differs from what the student saw).
 */
export function priceCart(lines: CartLine[], items: MenuItem[], offers: Offer[] = [], clock: CafeClock = cafeClock()): PricedCart {
  const byId = new Map(items.map((i) => [i.id, i]))
  const priced = lines.map<PricedLine>((line) => {
    const item = byId.get(line.menu_item_id) ?? null
    if (!item) return { line, item: null, addons: [], discount: 0, offerTitle: null, unitPrice: 0, lineTotal: 0, issue: 'item_missing' }
    const addons = item.addons
      .filter((a) => line.addon_ids.includes(a.id))
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
      .map((a) => ({ id: a.id, name: a.name, price: a.price }))
    const missingAddon =
      addons.length !== line.addon_ids.length ||
      item.addons.some((a) => line.addon_ids.includes(a.id) && !a.is_available)
    const { discount, offer } = offerPrice(item, offers, clock)
    const price = unitPrice(item, line.addon_ids) - discount
    const issue: LineIssue | null = !item.is_available ? 'item_unavailable' : missingAddon ? 'addon_unavailable' : null
    return { line, item, addons, discount, offerTitle: offer?.title ?? null, unitPrice: price, lineTotal: price * line.quantity, issue }
  })
  const valid = priced.filter((p) => !p.issue)
  return {
    lines: priced,
    total: valid.reduce((s, p) => s + p.lineTotal, 0),
    units: valid.reduce((s, p) => s + p.line.quantity, 0),
    savings: valid.reduce((s, p) => s + p.discount * p.line.quantity, 0),
    hasIssues: priced.some((p) => p.issue),
  }
}

export function clampQty(n: number) {
  if (!Number.isFinite(n)) return 1
  return Math.min(MAX_QTY_PER_LINE, Math.max(1, Math.round(n)))
}
