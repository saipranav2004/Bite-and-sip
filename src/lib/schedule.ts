// Pre-order pickup times: 15-minute slots later today, from 20 minutes out.
// The database accepts anything 15 minutes to 12 hours ahead, on the same café day.
import { cafeClock } from './offers'

export interface PickupSlot {
  iso: string
  label: string
}

const SLOT = 15
const LEAD = 20
const LAST = 22 * 60 + 45 // last pickup 10:45 pm

export function pickupSlots(now: Date = new Date(), max = 24): PickupSlot[] {
  const clock = cafeClock(now)
  const startMinutes = Math.ceil((clock.minutes + LEAD) / SLOT) * SLOT
  const midnight = new Date(`${clock.date}T00:00:00+05:30`).getTime()
  const out: PickupSlot[] = []
  for (let m = startMinutes; m <= LAST && out.length < max; m += SLOT) {
    const at = new Date(midnight + m * 60000)
    out.push({ iso: at.toISOString(), label: slotLabel(at.toISOString()) })
  }
  return out
}

export function slotLabel(iso: string) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso))
}

/** A pre-order is "due" in the kitchen 15 minutes before its pickup time. */
export function isDue(scheduledFor: string | null, now = Date.now()) {
  return !scheduledFor || new Date(scheduledFor).getTime() - 15 * 60000 <= now
}

export function minutesUntil(iso: string, now = Date.now()) {
  return Math.round((new Date(iso).getTime() - now) / 60000)
}
