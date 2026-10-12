// Offers: which discount applies to an item right now. Mirrors
// private.best_offer() in the database, which is what actually prices orders.
import { TIME_ZONE } from './format'
import type { Offer } from './types'

export interface CafeClock {
  /** YYYY-MM-DD in café time. */
  date: string
  /** ISO weekday, 1 = Monday. */
  dow: number
  /** Minutes since midnight, café time. */
  minutes: number
}

const parts = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})
const DOW: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

export function cafeClock(at: Date = new Date()): CafeClock {
  const p = Object.fromEntries(parts.formatToParts(at).map((x) => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, dow: DOW[p.weekday], minutes: Number(p.hour) * 60 + Number(p.minute) }
}

/** "17:30" / "17:30:00" / "24:00:00" → minutes since midnight. */
export function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + (m || 0)
}

export function isOfferLive(o: Offer, clock: CafeClock): boolean {
  return (
    o.is_active &&
    (o.days.length === 0 || o.days.includes(clock.dow)) &&
    clock.minutes >= toMinutes(o.starts_at) &&
    clock.minutes < toMinutes(o.ends_at) &&
    (!o.valid_from || clock.date >= o.valid_from) &&
    (!o.valid_to || clock.date <= o.valid_to)
  )
}

export function appliesTo(o: Offer, menuItemId: string) {
  return o.menu_item_ids.length === 0 || o.menu_item_ids.includes(menuItemId)
}

/** The best live offer for an item (highest discount; ties by title). */
export function bestOffer(menuItemId: string, offers: Offer[], clock: CafeClock): Offer | null {
  let best: Offer | null = null
  for (const o of offers) {
    if (!appliesTo(o, menuItemId) || !isOfferLive(o, clock)) continue
    if (!best || o.percent_off > best.percent_off || (o.percent_off === best.percent_off && o.title < best.title)) best = o
  }
  return best
}

/** Rupees off one unit's base price (rounded down, like the database). */
export function discountFor(price: number, percentOff: number) {
  return Math.floor((price * percentOff) / 100)
}

const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function timeLabel(t: string) {
  const m = toMinutes(t)
  if (m === 0 || m === 1440) return 'midnight'
  const h = Math.floor(m / 60)
  const min = m % 60
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}${min ? `:${String(min).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`
}

export function daysLabel(days: number[]) {
  if (days.length === 0 || days.length === 7) return 'Every day'
  const sorted = [...days].sort((a, b) => a - b)
  if (sorted.join() === '1,2,3,4,5') return 'Mon–Fri'
  if (sorted.join() === '6,7') return 'Weekends'
  if (sorted.join() === '1,2,3,4,5,6') return 'Mon–Sat'
  return sorted.map((d) => DAY_SHORT[d - 1]).join(', ')
}

export function windowLabel(o: Pick<Offer, 'starts_at' | 'ends_at'>) {
  const s = toMinutes(o.starts_at)
  const e = toMinutes(o.ends_at)
  if (s === 0 && e >= 1440) return 'All day'
  if (e >= 1440) return `From ${timeLabel(o.starts_at)}`
  return `${timeLabel(o.starts_at)}–${timeLabel(o.ends_at)}`
}

/** When a live offer ends today ("5 pm"), or null if it runs to the end of the day. */
export function endTime(o: Offer): string | null {
  return toMinutes(o.ends_at) >= 1440 ? null : timeLabel(o.ends_at)
}

/** Live offers right now, best first. */
export function liveOffers(offers: Offer[], clock: CafeClock) {
  return offers.filter((o) => isOfferLive(o, clock)).sort((a, b) => b.percent_off - a.percent_off || a.title.localeCompare(b.title))
}
