// Sends push notifications. Called only by the database (pg_net, after a
// commit) with a shared secret — never by browsers. Deploy with JWT
// verification off; the x-push-secret header is the authentication.
//
// Secrets: PUSH_HOOK_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.
// Provided by Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
import { staffNotice, studentNotice, type Lang, type PushEvent } from './messages.ts'
import { sendPush, type VapidKeys } from './webpush.ts'

const env = (k: string) => Deno.env.get(k) ?? ''
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function sameSecret(a: string, b: string) {
  if (!a || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function rest(path: string, init: RequestInit = {}) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY')
  const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!res.ok) throw new Error(`rest ${res.status}: ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

interface Sub {
  id: string
  endpoint: string
  p256dh: string
  auth: string
  lang: Lang
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  if (!sameSecret(req.headers.get('x-push-secret') ?? '', env('PUSH_HOOK_SECRET'))) {
    return new Response('Forbidden', { status: 403 })
  }
  const keys: VapidKeys = { publicKey: env('VAPID_PUBLIC_KEY'), privateKey: env('VAPID_PRIVATE_KEY'), subject: env('VAPID_SUBJECT') }

  let e: PushEvent
  try {
    e = await req.json()
  } catch {
    return new Response('Bad request', { status: 400 })
  }

  const forStudent = e.event === 'order_ready' || e.event === 'order_cancelled'
  if (forStudent && !UUID.test(e.order_id ?? '')) return new Response('Bad request', { status: 400 })
  const filter = forStudent ? `order_id=eq.${e.order_id}` : 'user_id=not.is.null'
  const subs = (await rest(`push_subscriptions?select=id,endpoint,p256dh,auth,lang&${filter}`)) as Sub[]

  const gone: string[] = []
  let sent = 0
  await Promise.all(subs.map(async (s) => {
    const notice = forStudent ? studentNotice(e, s.lang) : staffNotice(e)
    if (!notice) return
    try {
      const status = await sendPush(s, notice, keys, {
        ttl: forStudent ? 1800 : 3600,
        urgency: 'high',
        topic: notice.tag,
      })
      if (status === 404 || status === 410) gone.push(s.id)
      else if (status < 300) sent += 1
      else console.warn('push rejected', status, new URL(s.endpoint).host)
    } catch (err) {
      console.warn('push failed', new URL(s.endpoint).host, String(err))
    }
  }))

  // Expired browsers, and student subscriptions for orders that are done.
  if (gone.length) await rest(`push_subscriptions?id=in.(${gone.join(',')})`, { method: 'DELETE' })
  const stale = new Date(Date.now() - 2 * 86400000).toISOString()
  await rest(`push_subscriptions?order_id=not.is.null&created_at=lt.${stale}`, { method: 'DELETE' })

  return Response.json({ sent, removed: gone.length, targets: subs.length })
})
