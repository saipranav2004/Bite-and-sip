import { describe, expect, it } from 'vitest'
import { menuEngineering } from './insights'
import { bestOffer, cafeClock, daysLabel, discountFor, isOfferLive, windowLabel } from './offers'
import { priceCart } from './pricing'
import { isDue, pickupSlots } from './schedule'
import { dailyUse, roundPurchase, shoppingList, usageCheck } from './shopping'
import type { Ingredient, IngredientUsage, MenuItem, Offer } from './types'

const offer = (o: Partial<Offer>): Offer => ({
  id: o.title ?? 'o', title: 'Offer', percent_off: 10, menu_item_ids: [], days: [], starts_at: '00:00:00', ends_at: '24:00:00',
  valid_from: null, valid_to: null, is_active: true, ...o,
})
// Monday 12 Oct 2026, 3:30 pm in India.
const MON_1530 = cafeClock(new Date('2026-10-12T10:00:00Z'))

describe('offers', () => {
  it('reads the café clock in India time', () => {
    expect(MON_1530).toEqual({ date: '2026-10-12', dow: 1, minutes: 15 * 60 + 30 })
    expect(cafeClock(new Date('2026-10-11T18:45:00Z'))).toEqual({ date: '2026-10-12', dow: 1, minutes: 15 })
  })

  it('applies only on its days, hours and dates', () => {
    expect(isOfferLive(offer({ starts_at: '15:00', ends_at: '17:00' }), MON_1530)).toBe(true)
    expect(isOfferLive(offer({ starts_at: '15:30', ends_at: '17:00' }), MON_1530)).toBe(true)
    expect(isOfferLive(offer({ starts_at: '13:00', ends_at: '15:30' }), MON_1530)).toBe(false)
    expect(isOfferLive(offer({ days: [6, 7] }), MON_1530)).toBe(false)
    expect(isOfferLive(offer({ days: [1] }), MON_1530)).toBe(true)
    expect(isOfferLive(offer({ valid_from: '2026-10-13' }), MON_1530)).toBe(false)
    expect(isOfferLive(offer({ valid_to: '2026-10-12' }), MON_1530)).toBe(true)
    expect(isOfferLive(offer({ is_active: false }), MON_1530)).toBe(false)
  })

  it('picks the biggest discount for the item and rounds down like the database', () => {
    const offers = [offer({ title: 'All', percent_off: 10 }), offer({ title: 'Shake', percent_off: 20, menu_item_ids: ['shake'] })]
    expect(bestOffer('shake', offers, MON_1530)?.title).toBe('Shake')
    expect(bestOffer('chai', offers, MON_1530)?.title).toBe('All')
    expect(discountFor(45, 20)).toBe(9)
    expect(discountFor(35, 15)).toBe(5)
    expect(discountFor(80, 15)).toBe(12)
  })

  it('describes the schedule in plain words', () => {
    expect(daysLabel([1, 2, 3, 4, 5])).toBe('Mon–Fri')
    expect(daysLabel([])).toBe('Every day')
    expect(daysLabel([6, 7])).toBe('Weekends')
    expect(windowLabel({ starts_at: '15:00:00', ends_at: '17:30:00' })).toBe('3 pm–5:30 pm')
    expect(windowLabel({ starts_at: '00:00:00', ends_at: '24:00:00' })).toBe('All day')
  })
})

const item = (id: string, price: number, extra: Partial<MenuItem> = {}): MenuItem => ({
  id, category_id: 'c', name: id, description: '', price, is_veg: true, is_available: true, is_popular: false, image_path: null, sort_order: 0, addons: [], ...extra,
})

describe('cart pricing with offers', () => {
  it('discounts the base price, not add-ons, and reports savings', () => {
    const rice = item('rice', 80, { addons: [{ id: 'p', menu_item_id: 'rice', name: 'Paneer', price: 25, is_available: true, sort_order: 0 }] })
    const cart = priceCart(
      [{ key: 'a', menu_item_id: 'rice', addon_ids: ['p'], quantity: 2, note: '' }, { key: 'b', menu_item_id: 'chai', addon_ids: [], quantity: 1, note: '' }],
      [rice, item('chai', 15)],
      [offer({ title: 'Rice', percent_off: 15, menu_item_ids: ['rice'] })],
      MON_1530,
    )
    expect(cart.lines[0]).toMatchObject({ unitPrice: 93, lineTotal: 186, discount: 12, offerTitle: 'Rice' })
    expect(cart.total).toBe(201)
    expect(cart.savings).toBe(24)
  })
})

describe('pickup slots', () => {
  it('offers 15-minute slots from 20 minutes ahead, same day, until 10:45 pm', () => {
    const slots = pickupSlots(new Date('2026-10-12T10:00:00Z')) // 3:30 pm IST
    expect(slots[0].label).toBe('4:00 pm')
    expect(new Date(slots[0].iso).toISOString()).toBe('2026-10-12T10:30:00.000Z')
    expect(slots.length).toBe(24)
    const late = pickupSlots(new Date('2026-10-12T17:00:00Z')) // 10:30 pm IST
    expect(late).toEqual([])
  })

  it('treats a pre-order as due 15 minutes before pickup', () => {
    const now = Date.parse('2026-10-12T10:00:00Z')
    expect(isDue(null, now)).toBe(true)
    expect(isDue('2026-10-12T10:20:00Z', now)).toBe(false)
    expect(isDue('2026-10-12T10:15:00Z', now)).toBe(true)
  })
})

describe('menu insights', () => {
  it('sorts items into the four groups', () => {
    const menu = [item('Chai', 15), item('Maggi', 40), item('Shake', 45), item('Sandwich', 50), item('Wrap', 60)]
    const sold = [
      { name: 'Chai', quantity: 100, sales: 1500, cost: 600 }, // popular, ₹9/unit
      { name: 'Maggi', quantity: 60, sales: 2400, cost: 900 }, // popular, ₹25/unit
      { name: 'Shake', quantity: 5, sales: 225, cost: 75 }, // rare, ₹30/unit
      { name: 'Sandwich', quantity: 4, sales: 200, cost: 160 }, // rare, ₹10/unit
    ]
    const r = menuEngineering(sold, menu, { items: {}, addons: {} })
    const k = Object.fromEntries(r.rows.map((x) => [x.name, x.klass]))
    expect(k).toEqual({ Chai: 'plowhorse', Maggi: 'star', Shake: 'puzzle', Sandwich: 'dog', Wrap: 'unknown' })
    expect(Math.round(r.averageMargin!)).toBe(15) // (900 + 1500 + 150 + 40) ÷ 169 units
  })
})

const ing = (o: Partial<Ingredient>): Ingredient => ({
  id: 'i', name: 'Milk', base_unit: 'ml', display_unit: 'L', on_hand: 0, low_at: 0, cost_per_unit: null, is_active: true, updated_at: '', ...o,
})
const use = (o: Partial<IngredientUsage>): IngredientUsage => ({
  ingredient_id: 'i', sold: 0, used: 0, wasted: 0, purchased: 0, spent: 0, count_difference: 0, counts: 0, corrected: 0, first_movement_at: null, ...o,
})

describe('shopping list', () => {
  const now = Date.parse('2026-10-12T10:00:00Z')
  it('works out daily use since the ingredient was added (max 14 days)', () => {
    expect(dailyUse(use({ sold: 14000 }), now)).toBe(1000)
    expect(dailyUse(use({ sold: 3000, first_movement_at: '2026-10-09T10:00:00Z' }), now)).toBe(1000)
  })

  it('rounds purchases to what you can buy', () => {
    expect(roundPurchase(1200, 'L')).toBe(1500)
    expect(roundPurchase(130, 'g')).toBe(150)
    expect(roundPurchase(13, 'dozen')).toBe(24)
    expect(roundPurchase(2.2, 'packet')).toBe(3)
  })

  it('buys enough to last the chosen days and end at the low level', () => {
    const milk = ing({ id: 'm', on_hand: 2000, low_at: 1000, cost_per_unit: 0.06 })
    const sugar = ing({ id: 's', name: 'Sugar', base_unit: 'g', display_unit: 'kg', on_hand: 5000, low_at: 500 })
    const salt = ing({ id: 'x', name: 'Salt', base_unit: 'g', display_unit: 'kg', on_hand: 100, low_at: 200 })
    const rows = shoppingList([milk, sugar, salt], [use({ ingredient_id: 'm', sold: 14000 }), use({ ingredient_id: 's', sold: 1400 })], 3, now)
    expect(rows.map((r) => r.ingredient.name)).toEqual(['Salt', 'Milk'])
    const m = rows.find((r) => r.ingredient.id === 'm')!
    // 1 L/day × 3 days + 1 L low level − 2 L on hand = 2 L.
    expect(m).toMatchObject({ buy: 2000, daysLeft: 2, estimatedCost: 120, reason: 'runs_out' })
    expect(rows.find((r) => r.ingredient.id === 'x')).toMatchObject({ buy: 500, reason: 'below_low' })
  })
})

describe('usage check', () => {
  it('shows what counts revealed against what sales and logs explain', () => {
    const milk = ing({ id: 'm', cost_per_unit: 0.06 })
    const rows = usageCheck([milk], [use({ ingredient_id: 'm', sold: 9000, wasted: 1000, count_difference: -2000, counts: 2 })])
    expect(rows[0]).toMatchObject({ expected: 10000, actual: 12000, gap: 2000, gapPct: 0.2, gapValue: 120, status: 'high' })
    const ok = usageCheck([milk], [use({ ingredient_id: 'm', sold: 10000, count_difference: -300, counts: 1 })])
    expect(ok[0].status).toBe('ok')
    const surplus = usageCheck([milk], [use({ ingredient_id: 'm', sold: 10000, count_difference: 1500, counts: 1 })])
    expect(surplus[0].status).toBe('surplus')
    const uncounted = usageCheck([milk], [use({ ingredient_id: 'm', sold: 10000 })])
    expect(uncounted[0].status).toBe('not_counted')
  })
})

describe('kitchen ticket', () => {
  it('shows the table, items and notes, and escapes what customers typed', async () => {
    const { ticketHtml } = await import('./printTicket')
    const html = ticketHtml({
      id: 'x', order_no: 1042, customer_name: '<b>Riya</b>', customer_phone: '9876543210', table_label: 'T3', status: 'placed',
      payment_method: 'cash', payment_status: 'unpaid', customer_reported_paid_at: null, payment_reference: null, total: 55, item_count: 2,
      cancel_reason: null, cancelled_by: null, scheduled_for: null, created_at: '2026-10-12T06:00:00Z', updated_at: '', preparing_at: null,
      ready_at: null, completed_at: null, cancelled_at: null, paid_at: null,
      items: [{ name: 'Maggi', base_price: 40, addons: [{ id: 'a', name: 'Extra Cheese', price: 15 }], unit_price: 55, quantity: 1, line_total: 55, note: 'no <script>' }],
    }, 'Bite & Sip')
    expect(html).toContain('BS-1042')
    expect(html).toContain('TABLE T3')
    expect(html).toContain('+ Extra Cheese')
    expect(html).toContain('NOTE: no &lt;script&gt;')
    expect(html).toContain('&lt;b&gt;Riya&lt;/b&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('CASH · NOT PAID')
  })
})
