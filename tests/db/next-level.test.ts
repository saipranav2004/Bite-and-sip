// Offers, pre-orders, help at the table, feedback, push events, the kitchen
// screen, daily cash closing and ingredient usage — against local Supabase.
import type { SupabaseClient } from '@supabase/supabase-js'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cafeDate } from '../../src/lib/format'
import { ITEM, admin, anonClient, newToken, placeOrder, setSettings, staffClient } from './helpers'

// Items no other test file prices, so offers here can't disturb other totals.
const SHAKE = ITEM['Chocolate Shake'] // ₹45
const RICE = ITEM['Veg Fried Rice'] // ₹80, add-on Extra Paneer ₹25
const SODA = ITEM['Fresh Lime Soda'] // ₹25
const PANEER = RICE.addons.find((a) => a.name === 'Extra Paneer')!.id
const tag = randomUUID().slice(0, 6)
const today = () => cafeDate(new Date())

let anon: SupabaseClient
let owner: SupabaseClient
let kitchen: SupabaseClient
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' })

beforeAll(async () => {
  anon = anonClient()
  owner = await staffClient('owner', 'Next Owner')
  kitchen = await staffClient('kitchen', 'Next Kitchen')
  await setSettings({ is_open: true, upi_id: 'demo.bitesip@exampleupi' })
  await db.connect()
})

afterAll(async () => {
  await admin.from('offers').delete().like('title', `%${tag}%`)
  await admin.from('service_requests').delete().in('table_label', ['T10', 'T11'])
  await admin.from('push_subscriptions').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  await admin.from('recipe_lines').delete().eq('menu_item_id', SODA.id)
  await db.query('update private.app_config set push_url = null, push_secret = null, vapid_public_key = null, kitchen_key = null, kitchen_topic = null')
  await db.end()
})

async function order(items: unknown, extra: Parameters<typeof placeOrder>[1] = {}) {
  const res = await placeOrder(anon, { ...extra, p_items: items })
  if (res.error) throw new Error(`${res.error.message} ${res.error.hint ?? ''}`)
  return { order: res.data as Record<string, any>, token: res.token }
}

async function serve(id: string) {
  for (const status of ['preparing', 'ready']) {
    const r = await owner.from('orders').update({ status }).eq('id', id)
    if (r.error) throw new Error(r.error.message)
  }
  const r = await owner.from('orders').update({ status: 'completed', payment_status: 'paid' }).eq('id', id)
  if (r.error) throw new Error(r.error.message)
}

const isoDow = (d: Date) => {
  const day = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getDay()
  return day === 0 ? 7 : day
}

describe('offers', () => {
  it('are public to read and owner-only to write', async () => {
    expect((await anon.from('offers').select('id').limit(1)).error).toBeNull()
    expect((await anon.from('offers').insert({ title: 'x', percent_off: 10 })).error).not.toBeNull()
    expect((await kitchen.from('offers').insert({ title: 'x', percent_off: 10 })).error).not.toBeNull()
    expect((await owner.from('offers').insert({ title: `Bad ${tag}`, percent_off: 95 })).error).not.toBeNull()
    expect((await owner.from('offers').insert({ title: `Bad ${tag}`, percent_off: 10, starts_at: '17:00', ends_at: '15:00' })).error).not.toBeNull()
  })

  it('discounts the base price (not add-ons), rounding down, and the best offer wins', async () => {
    const created = await owner.from('offers').insert([
      { title: `Shake hour ${tag}`, percent_off: 20, menu_item_ids: [SHAKE.id] },
      { title: `Small ${tag}`, percent_off: 10, menu_item_ids: [SHAKE.id, RICE.id] },
      { title: `Rice ${tag}`, percent_off: 15, menu_item_ids: [RICE.id] },
    ]).select('id')
    expect(created.error).toBeNull()

    const { order: o } = await order([
      { menu_item_id: SHAKE.id, quantity: 2 },
      { menu_item_id: RICE.id, quantity: 1, addon_ids: [PANEER] },
    ])
    // Shake: 45 − floor(9) = 36 ×2 = 72. Rice: 80 − floor(12) + 25 = 93.
    expect(o.total).toBe(165)
    const shake = o.items.find((i: any) => i.name === SHAKE.name)
    expect(shake).toMatchObject({ base_price: 45, discount: 9, unit_price: 36, offer_title: `Shake hour ${tag}`, menu_item_id: SHAKE.id })
    const rice = o.items.find((i: any) => i.name === RICE.name)
    expect(rice).toMatchObject({ base_price: 80, discount: 12, unit_price: 93, offer_title: `Rice ${tag}` })

    const audit = await owner.from('audit_log').select('action').eq('entity', 'offer').eq('label', `Shake hour ${tag}`)
    expect(audit.data).toEqual([{ action: 'offer.created' }])
  })

  it('ignores inactive offers and ones outside their days or dates', async () => {
    const otherDay = (isoDow(new Date()) % 7) + 1
    await owner.from('offers').update({ is_active: false }).like('title', `%${tag}%`)
    await owner.from('offers').insert([
      { title: `Other day ${tag}`, percent_off: 50, menu_item_ids: [SHAKE.id], days: [otherDay] },
      { title: `Future ${tag}`, percent_off: 50, menu_item_ids: [SHAKE.id], valid_from: '2999-01-01' },
      { title: `Past ${tag}`, percent_off: 50, menu_item_ids: [SHAKE.id], valid_to: '2000-01-01' },
    ])
    const { order: o } = await order([{ menu_item_id: SHAKE.id, quantity: 1 }])
    expect(o.total).toBe(45)
    expect(o.items[0].discount).toBe(0)
    expect(o.items[0].offer_title).toBeNull()
  })

  it('refuses when the student saw a different total', async () => {
    const res = await placeOrder(anon, { p_items: [{ menu_item_id: SHAKE.id, quantity: 1 }] })
    expect(res.error).toBeNull()
    const changed = await anon.rpc('place_order', {
      p_client_request_id: randomUUID(), p_access_token: newToken(), p_customer_name: 'Riya', p_customer_phone: '9876500011',
      p_payment_method: 'cash', p_table_label: null, p_items: [{ menu_item_id: SHAKE.id, quantity: 1 }], p_expected_total: 36,
    })
    expect(changed.error?.message).toBe('prices_changed')
    expect(changed.error?.hint).toBe('45')
    const ok = await anon.rpc('place_order', {
      p_client_request_id: randomUUID(), p_access_token: newToken(), p_customer_name: 'Riya', p_customer_phone: '9876500012',
      p_payment_method: 'cash', p_table_label: null, p_items: [{ menu_item_id: SHAKE.id, quantity: 1 }], p_expected_total: 45,
    })
    expect(ok.error).toBeNull()
  })

  it('reports how each offer did', async () => {
    await owner.from('offers').update({ is_active: true }).eq('title', `Shake hour ${tag}`)
    await order([{ menu_item_id: SHAKE.id, quantity: 3 }])
    const stats = await owner.rpc('offer_stats', { p_from: today(), p_to: today() })
    expect(stats.error).toBeNull()
    const row = (stats.data as any[]).find((s) => s.title === `Shake hour ${tag}`)
    expect(row).toMatchObject({ orders: 2, units: 5, discount: 45, sales: 180 })
    expect((await kitchen.rpc('offer_stats', { p_from: today(), p_to: today() })).error?.message).toBe('owner_only')
    await owner.from('offers').update({ is_active: false }).like('title', `%${tag}%`)
  })
})

describe('pre-orders', () => {
  it('accepts a pickup time later today and rejects too soon, too late or another day', async () => {
    const at = (min: number) => new Date(Date.now() + min * 60000).toISOString()
    const soon = await placeOrder(anon, { p_items: [{ menu_item_id: SODA.id, quantity: 1 }], p_table_label: null })
    expect(soon.error).toBeNull()
    for (const bad of [at(5), at(13 * 60), at(26 * 60)]) {
      const res = await anon.rpc('place_order', {
        p_client_request_id: randomUUID(), p_access_token: newToken(), p_customer_name: 'Riya', p_customer_phone: '9876500021',
        p_payment_method: 'cash', p_table_label: null, p_items: [{ menu_item_id: SODA.id, quantity: 1 }], p_scheduled_for: bad,
      })
      expect(res.error?.message, bad).toBe('invalid_pickup_time')
    }
    const when = new Date(Date.now() + 40 * 60000)
    if (cafeDate(when) !== today()) return // too close to midnight to schedule today
    const res = await anon.rpc('place_order', {
      p_client_request_id: randomUUID(), p_access_token: newToken(), p_customer_name: 'Riya', p_customer_phone: '9876500022',
      p_payment_method: 'cash', p_table_label: null, p_items: [{ menu_item_id: SODA.id, quantity: 1 }], p_scheduled_for: when.toISOString(),
    })
    expect(res.error).toBeNull()
    const scheduled = new Date(res.data.scheduled_for)
    expect(scheduled.getSeconds()).toBe(0)
    expect(Math.abs(scheduled.getTime() - when.getTime())).toBeLessThan(60000)
    const staffView = await owner.from('orders').select('scheduled_for').eq('id', res.data.id).single()
    expect(staffView.data!.scheduled_for).not.toBeNull()
  })
})

describe('wait time', () => {
  it('gives students an estimate without any order details', async () => {
    const res = await anon.rpc('kitchen_eta')
    expect(res.error).toBeNull()
    expect(res.data.minutes).toBeGreaterThanOrEqual(5)
    expect(res.data.minutes).toBeLessThanOrEqual(60)
    expect(typeof res.data.queue).toBe('number')
    expect(Object.keys(res.data).sort()).toEqual(['minutes', 'queue', 'samples', 'typical_minutes'])
  })
})

describe('feedback', () => {
  it('is accepted once the order is served, can be changed, and only the owner reads it', async () => {
    const { order: o, token } = await order([{ menu_item_id: SODA.id, quantity: 1 }])
    const early = await anon.rpc('leave_feedback', { p_order_id: o.id, p_access_token: token, p_rating: 5, p_comment: 'x' })
    expect(early.error?.message).toBe('not_allowed')
    await serve(o.id)
    expect((await anon.rpc('leave_feedback', { p_order_id: o.id, p_access_token: newToken(), p_rating: 5, p_comment: null })).error?.message).toBe('order_not_found')
    expect((await anon.rpc('leave_feedback', { p_order_id: o.id, p_access_token: token, p_rating: 6, p_comment: null })).error?.message).toBe('invalid_rating')
    const ok = await anon.rpc('leave_feedback', { p_order_id: o.id, p_access_token: token, p_rating: 5, p_comment: '  Great   soda ' })
    expect(ok.error).toBeNull()
    expect(ok.data.feedback).toEqual({ rating: 5, comment: 'Great soda' })
    const again = await anon.rpc('leave_feedback', { p_order_id: o.id, p_access_token: token, p_rating: 4, p_comment: null })
    expect(again.data.feedback).toEqual({ rating: 4, comment: null })

    const asOwner = await owner.from('order_feedback').select('rating, comment, order:orders(order_no)').eq('order_id', o.id).single()
    expect(asOwner.data).toMatchObject({ rating: 4, order: { order_no: o.order_no } })
    expect((await kitchen.from('order_feedback').select('*').eq('order_id', o.id)).data).toEqual([])
    expect((await anon.from('order_feedback').select('*').limit(1)).error).not.toBeNull()
  })
})

describe('help at the table', () => {
  it('lets a table call staff once per need, and staff resolve it', async () => {
    const first = await anon.rpc('request_service', { p_table_label: 't10', p_kind: 'water' })
    expect(first.error).toBeNull()
    expect(first.data).toMatchObject({ table_label: 'T10', kind: 'water', resolved_at: null })
    const dup = await anon.rpc('request_service', { p_table_label: 'T10', p_kind: 'water' })
    expect(dup.data.id).toBe(first.data.id)
    expect((await anon.rpc('request_service', { p_table_label: 'T99', p_kind: 'water' })).error?.message).toBe('table_not_found')
    expect((await anon.rpc('request_service', { p_table_label: 'T10', p_kind: 'pizza' })).error?.message).toBe('invalid_request')

    expect((await anon.from('service_requests').select('*').limit(1)).error).not.toBeNull()
    const seen = await kitchen.from('service_requests').select('id, kind').eq('id', first.data.id)
    expect(seen.data).toEqual([{ id: first.data.id, kind: 'water' }])

    expect((await anon.rpc('resolve_service_request', { p_id: first.data.id })).error).not.toBeNull()
    const done = await owner.rpc('resolve_service_request', { p_id: first.data.id })
    expect(done.data.resolved_at).not.toBeNull()
    const status = await anon.rpc('service_request_status', { p_ids: [first.data.id] })
    expect(status.data[0].resolved_at).not.toBeNull()
  })

  it('limits how often one table can call', async () => {
    for (let i = 0; i < 6; i++) {
      const r = await anon.rpc('request_service', { p_table_label: 'T11', p_kind: 'help' })
      expect(r.error, `request ${i}`).toBeNull()
      await owner.rpc('resolve_service_request', { p_id: r.data.id })
    }
    expect((await anon.rpc('request_service', { p_table_label: 'T11', p_kind: 'help' })).error?.message).toBe('too_many_requests')
  })

  it('is refused while the café is closed', async () => {
    await setSettings({ is_open: false })
    try {
      expect((await anon.rpc('request_service', { p_table_label: 'T10', p_kind: 'bill' })).error?.message).toBe('cafe_closed')
    } finally {
      await setSettings({ is_open: true })
    }
  })
})

const sub = (n: string, host = 'https://fcm.googleapis.com/fcm/send/') => ({
  endpoint: `${host}${n}-${tag}`,
  keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) },
})

describe('push subscriptions', () => {
  it('stay hidden until push is configured', async () => {
    expect((await anon.rpc('push_public_key')).data).toBeNull()
  })

  it('accept only real push services and a valid order secret', async () => {
    const { order: o, token } = await order([{ menu_item_id: SODA.id, quantity: 1 }])
    const bad = await anon.rpc('subscribe_order_push', { p_order_id: o.id, p_access_token: token, p_subscription: sub('x', 'http://169.254.169.254/') })
    expect(bad.error?.message).toBe('invalid_subscription')
    const evil = await anon.rpc('subscribe_order_push', { p_order_id: o.id, p_access_token: token, p_subscription: sub('x', 'https://fcm.googleapis.com.evil.com/') })
    expect(evil.error?.message).toBe('invalid_subscription')
    const wrong = await anon.rpc('subscribe_order_push', { p_order_id: o.id, p_access_token: newToken(), p_subscription: sub('a') })
    expect(wrong.error?.message).toBe('order_not_found')
    for (const n of ['a', 'b', 'c', 'a']) {
      expect((await anon.rpc('subscribe_order_push', { p_order_id: o.id, p_access_token: token, p_subscription: sub(n), p_lang: 'te' })).error, n).toBeNull()
    }
    expect((await anon.rpc('subscribe_order_push', { p_order_id: o.id, p_access_token: token, p_subscription: sub('d') })).error?.message).toBe('too_many_requests')
    const rows = await admin.from('push_subscriptions').select('endpoint, lang').eq('order_id', o.id)
    expect(rows.data).toHaveLength(3)
    expect(rows.data!.every((r) => r.lang === 'te')).toBe(true)
    expect((await anon.from('push_subscriptions').select('*').limit(1)).error).not.toBeNull()
    expect((await owner.from('push_subscriptions').select('*').limit(1)).error).not.toBeNull()
  })

  it('lets staff (only) subscribe a device, check it, and unsubscribe', async () => {
    expect((await anon.rpc('subscribe_staff_push', { p_subscription: sub('staff') })).error).not.toBeNull()
    expect((await owner.rpc('subscribe_staff_push', { p_subscription: sub('staff') })).error).toBeNull()
    expect((await owner.rpc('staff_push_enabled', { p_endpoint: sub('staff').endpoint })).data).toBe(true)
    expect((await owner.rpc('unsubscribe_push', { p_endpoint: sub('staff').endpoint })).error).toBeNull()
    expect((await owner.rpc('staff_push_enabled', { p_endpoint: sub('staff').endpoint })).data).toBe(false)
  })
})

describe('push events', () => {
  let server: Server
  const received: { body: any; secret: string | undefined }[] = []
  let gateway: string | null = null

  beforeAll(async () => {
    try {
      gateway = execSync("docker network inspect supabase_network_bite-and-sip -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}'", { encoding: 'utf8' }).trim() || null
    } catch {
      gateway = null
    }
    server = createServer((req, res) => {
      let data = ''
      req.on('data', (c) => (data += c))
      req.on('end', () => {
        received.push({ body: JSON.parse(data), secret: req.headers['x-push-secret'] as string | undefined })
        res.end('{}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '0.0.0.0', r))
    const port = (server.address() as AddressInfo).port
    await db.query("update private.app_config set push_url = $1, push_secret = 'test-secret', vapid_public_key = 'BTestKey'", [`http://${gateway}:${port}/push`])
  })

  afterAll(async () => {
    await db.query('update private.app_config set push_url = null, push_secret = null, vapid_public_key = null')
    await new Promise((r) => server.close(r))
  })

  const waitFor = async (pred: () => boolean, ms = 10000) => {
    const until = Date.now() + ms
    while (!pred() && Date.now() < until) await new Promise((r) => setTimeout(r, 100))
    return pred()
  }

  it('publishes the public key once configured', async () => {
    expect((await anon.rpc('push_public_key')).data).toBe('BTestKey')
  })

  it('tells the push function about new orders, UPI claims, help requests and ready orders (after commit)', async (ctx) => {
    if (!gateway) ctx.skip()
    await owner.rpc('subscribe_staff_push', { p_subscription: sub('owner-phone') })
    const { order: o, token } = await order([{ menu_item_id: SODA.id, quantity: 2 }, { menu_item_id: SHAKE.id, quantity: 1 }],
      { p_table_label: 'T10', p_payment_method: 'upi' })
    expect(await waitFor(() => received.some((r) => r.body.event === 'order_placed' && r.body.order_no === o.order_no))).toBe(true)
    const placed = received.find((r) => r.body.event === 'order_placed' && r.body.order_no === o.order_no)!
    expect(placed.secret).toBe('test-secret')
    expect(placed.body).toMatchObject({ table_label: 'T10', payment_method: 'upi', items: `1× ${SHAKE.name}, 2× ${SODA.name}` })
    expect(JSON.stringify(placed.body)).not.toContain(o.customer_name)

    await anon.rpc('report_upi_payment', { p_order_id: o.id, p_access_token: token })
    expect(await waitFor(() => received.some((r) => r.body.event === 'upi_reported' && r.body.order_no === o.order_no))).toBe(true)

    await anon.rpc('request_service', { p_table_label: 'T10', p_kind: 'cutlery' })
    expect(await waitFor(() => received.some((r) => r.body.event === 'service_request' && r.body.kind === 'cutlery'))).toBe(true)

    await anon.rpc('subscribe_order_push', { p_order_id: o.id, p_access_token: token, p_subscription: sub('student') })
    await owner.from('orders').update({ status: 'preparing' }).eq('id', o.id)
    await owner.from('orders').update({ status: 'ready' }).eq('id', o.id)
    expect(await waitFor(() => received.some((r) => r.body.event === 'order_ready' && r.body.order_id === o.id))).toBe(true)
    // "preparing" is not announced to students.
    expect(received.some((r) => r.body.event === 'order_preparing')).toBe(false)
  })

  it('never blocks an order when the push function is unreachable', async () => {
    await db.query("update private.app_config set push_url = 'http://10.255.255.1:9/push'")
    const res = await placeOrder(anon, { p_items: [{ menu_item_id: SODA.id, quantity: 1 }] })
    expect(res.error).toBeNull()
  })
})

describe('kitchen screen', () => {
  let key: string

  it('is off until the owner creates a link', async () => {
    expect((await anon.rpc('kitchen_board', { p_key: 'nope' })).error?.message).toBe('invalid_kitchen_link')
    expect((await kitchen.rpc('kitchen_link_reset', { p_enabled: true })).error?.message).toBe('owner_only')
    expect((await anon.rpc('kitchen_link')).error).not.toBeNull()
    const res = await owner.rpc('kitchen_link_reset', { p_enabled: true })
    expect(res.error).toBeNull()
    key = res.data.key
    expect(key).toMatch(/^[0-9a-f]{36}$/)
    expect((await owner.rpc('kitchen_link')).data.key).toBe(key)
  })

  it('shows what to cook without prices or phone numbers, and moves orders only to preparing and ready', async () => {
    const { order: o } = await order([{ menu_item_id: RICE.id, quantity: 1, addon_ids: [PANEER], note: 'less spicy' }],
      { p_customer_name: 'Riya Sharma', p_table_label: 'T10' })
    const board = await anon.rpc('kitchen_board', { p_key: key })
    expect(board.error).toBeNull()
    const ticket = board.data.orders.find((t: any) => t.id === o.id)
    expect(ticket).toMatchObject({ order_no: o.order_no, customer_name: 'Riya', table_label: 'T10', status: 'placed' })
    expect(ticket.items).toEqual([{ name: RICE.name, quantity: 1, note: 'less spicy', addons: ['Extra Paneer'] }])
    const text = JSON.stringify(board.data)
    expect(text).not.toMatch(/"total"|"price"|"customer_phone"|Sharma/)
    expect(board.data.topic).toMatch(/^[0-9a-f]{32}$/)

    expect((await anon.rpc('kitchen_advance', { p_key: key, p_order_id: o.id, p_to: 'completed' })).error?.message).toBe('not_allowed')
    expect((await anon.rpc('kitchen_advance', { p_key: key, p_order_id: o.id, p_to: 'ready' })).error?.message).toBe('conflict')
    expect((await anon.rpc('kitchen_advance', { p_key: 'wrong', p_order_id: o.id, p_to: 'preparing' })).error?.message).toBe('invalid_kitchen_link')
    expect((await anon.rpc('kitchen_advance', { p_key: key, p_order_id: o.id, p_to: 'preparing' })).error).toBeNull()
    expect((await anon.rpc('kitchen_advance', { p_key: key, p_order_id: o.id, p_to: 'ready' })).error).toBeNull()
    const row = await owner.from('orders').select('status, payment_status, ready_at').eq('id', o.id).single()
    expect(row.data).toMatchObject({ status: 'ready', payment_status: 'unpaid' })
  })

  it('stops working when the owner resets or turns off the link', async () => {
    const fresh = await owner.rpc('kitchen_link_reset', { p_enabled: true })
    expect(fresh.data.key).not.toBe(key)
    expect((await anon.rpc('kitchen_board', { p_key: key })).error?.message).toBe('invalid_kitchen_link')
    await owner.rpc('kitchen_link_reset', { p_enabled: false })
    expect((await owner.rpc('kitchen_link')).data.key).toBeNull()
    expect((await anon.rpc('kitchen_board', { p_key: fresh.data.key })).error?.message).toBe('invalid_kitchen_link')
  })
})

describe('daily cash closing', () => {
  it('works out expected cash from cash received, and records the count', async () => {
    const before = await owner.rpc('day_close_summary', { p_day: today() })
    expect(before.error).toBeNull()
    const { order: o } = await order([{ menu_item_id: SODA.id, quantity: 2 }])
    await serve(o.id)
    const after = await owner.rpc('day_close_summary', { p_day: today() })
    expect(after.data.cash_received - before.data.cash_received).toBeGreaterThanOrEqual(50)

    const closed = await owner.rpc('close_day', { p_day: today(), p_opening_float: 500, p_paid_out: 120, p_counted: 1000, p_note: ' short ' })
    expect(closed.error).toBeNull()
    const c = closed.data
    expect(c.expected_cash).toBe(500 + c.cash_received - 120)
    expect(c.difference).toBe(1000 - c.expected_cash)
    expect(c.note).toBe('short')
    expect(c.closed_by_name).toBe('Next Owner')

    const again = await owner.rpc('close_day', { p_day: today(), p_opening_float: 500, p_paid_out: 120, p_counted: c.expected_cash, p_note: null })
    expect(again.data.difference).toBe(0)
    const audit = await owner.from('audit_log').select('action').eq('entity', 'day').eq('entity_id', today()).order('id')
    expect(audit.data!.map((a) => a.action).slice(-1)).toEqual(['day.reclosed'])
    const summary = await owner.rpc('day_close_summary', { p_day: today() })
    expect(summary.data.closing.counted_cash).toBe(c.expected_cash)
  })

  it('is owner-only and refuses future days and bad amounts', async () => {
    expect((await kitchen.rpc('day_close_summary', { p_day: today() })).error?.message).toBe('owner_only')
    expect((await kitchen.from('day_closings').select('*')).data).toEqual([])
    expect((await owner.rpc('close_day', { p_day: '2999-01-01', p_opening_float: 0, p_paid_out: 0, p_counted: 0, p_note: null })).error?.message).toBe('invalid_range')
    expect((await owner.rpc('close_day', { p_day: today(), p_opening_float: -1, p_paid_out: 0, p_counted: 0, p_note: null })).error?.message).toBe('invalid_amount')
  })
})

describe('ingredient usage', () => {
  it('separates what recipes used, what was logged and what counts revealed', async () => {
    const ing = await owner.rpc('ingredient_save', { p: { name: `Lemon ${tag}`, base_unit: 'pcs', display_unit: 'pcs', opening: 40, low_at: 10 } })
    expect(ing.error).toBeNull()
    const id = ing.data.id
    expect((await admin.from('recipe_lines').insert({ menu_item_id: SODA.id, ingredient_id: id, quantity: 1 })).error).toBeNull()
    await order([{ menu_item_id: SODA.id, quantity: 3 }])
    const adjust = (kind: string, q: number) => owner.rpc('ingredient_adjust', {
      p_id: id, p_kind: kind, p_quantity: q, p_amount: kind === 'purchase' ? 100 : null, p_note: null, p_add_expense: false, p_label: null,
    })
    expect((await adjust('purchase', 20)).error).toBeNull()
    expect((await adjust('usage', 2)).error).toBeNull()
    expect((await adjust('waste', 1)).error).toBeNull()
    // Expected on hand: 40 − 3 + 20 − 2 − 1 = 54. Counted 50 → 4 unaccounted for.
    expect((await adjust('count', 50)).error).toBeNull()
    const usage = await owner.rpc('ingredient_usage', { p_from: today(), p_to: today() })
    expect(usage.error).toBeNull()
    const row = (usage.data as any[]).find((r) => r.ingredient_id === id)
    expect(row).toMatchObject({ sold: 3, used: 2, wasted: 1, purchased: 20, spent: 100, count_difference: -4, counts: 1 })
    expect(row.first_movement_at).not.toBeNull()
    expect((await kitchen.rpc('ingredient_usage', { p_from: today(), p_to: today() })).error?.message).toBe('owner_only')
  })
})
