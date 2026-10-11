const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })

export const TIME_ZONE = 'Asia/Kolkata'

export function money(rupees: number) {
  return inr.format(rupees)
}

export function orderCode(orderNo: number) {
  return `BS-${orderNo}`
}

export function timeOfDay(iso: string | null | undefined) {
  if (!iso) return ''
  return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: TIME_ZONE }).format(new Date(iso))
}

export function dateLabel(iso: string) {
  return new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TIME_ZONE }).format(new Date(iso))
}

/** Calendar date (YYYY-MM-DD) in the café's time zone. */
export function cafeDate(d: Date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(d)
}

/** Formats a YYYY-MM-DD string without time-zone drift. */
export function formatDay(day: string) {
  const [y, m, d] = day.split('-').map(Number)
  return new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  )
}

export function addDays(day: string, delta: number) {
  const [y, m, d] = day.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + delta))
  return dt.toISOString().slice(0, 10)
}

/** Start of the café's business day as an ISO timestamp (IST has no DST). */
export function cafeDayStartIso(day: string = cafeDate()) {
  return new Date(`${day}T00:00:00+05:30`).toISOString()
}

export function minutesSince(iso: string, now: number = Date.now()) {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000))
}

export function ago(iso: string, now: number = Date.now()) {
  const m = minutesSince(iso, now)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ${m % 60} min ago`
  const d = Math.floor(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

export function hourLabel(hour: number) {
  const h = hour % 12 === 0 ? 12 : hour % 12
  return `${h}${hour < 12 ? 'am' : 'pm'}`
}

/** Money with a true minus sign for losses: −₹1,200. */
export function signedMoney(rupees: number) {
  if (rupees === 0) return inr.format(0)
  return rupees < 0 ? `−${inr.format(-rupees)}` : inr.format(rupees)
}

const compact = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 })

/** Short form for KPI cards: ₹1.2L, ₹3.4Cr (full value below ₹1 lakh). */
export function moneyCompact(rupees: number) {
  const abs = Math.abs(rupees)
  const body = abs >= 100000 ? `₹${compact.format(abs)}` : inr.format(abs)
  return rupees < 0 ? `−${body}` : body
}

export function percent(fraction: number | null, digits = 1) {
  if (fraction === null || !Number.isFinite(fraction)) return '—'
  const v = (fraction * 100).toFixed(digits)
  return `${fraction < 0 ? '−' : ''}${v.replace('-', '')}%`
}

/** "12 Oct, 3:45 pm" in café time. */
export function dateTime(iso: string) {
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: TIME_ZONE }).format(new Date(iso))
}

/** First day of the month containing `day` (YYYY-MM-DD). */
export function monthStart(day: string) {
  return `${day.slice(0, 7)}-01`
}
