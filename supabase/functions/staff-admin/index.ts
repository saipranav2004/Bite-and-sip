// Staff accounts, managed by the owner from the app.
//
//   POST { action: 'create', login, display_name, role, password }
//   POST { action: 'reset_password', user_id, password }
//
// Creating sign-in accounts needs the service key, so it happens here, on the
// server, never in the browser. The caller must be an active owner. The staff
// row is inserted with the owner's own token, so the audit log names them.
// No third-party imports: plain fetch against the Auth and REST APIs.

const URL_ = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const LOGIN_DOMAIN = 'bite.local'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}
const fail = (status: number, error: string) => reply(status, { error })

async function call(path: string, init: RequestInit & { key?: string; token?: string } = {}) {
  const { key = SERVICE, token = SERVICE, ...rest } = init
  const res = await fetch(`${URL_}${path}`, {
    ...rest,
    headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(rest.headers ?? {}) },
  })
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { ok: res.ok, status: res.status, body }
}

function toLoginEmail(value: string) {
  const v = value.trim().toLowerCase()
  return v.includes('@') ? v : `${v}@${LOGIN_DOMAIN}`
}

const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/
const validPassword = (p: unknown): p is string => typeof p === 'string' && p.length >= 8 && p.length <= 72

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return fail(405, 'method_not_allowed')

  const auth = req.headers.get('Authorization') ?? ''
  const jwt = auth.replace(/^Bearer\s+/i, '')
  if (!jwt) return fail(401, 'not_signed_in')

  // Who is calling, and are they an active owner?
  const me = await call('/auth/v1/user', { key: ANON, token: jwt })
  if (!me.ok || !me.body?.id) return fail(401, 'not_signed_in')
  const caller = await call(`/rest/v1/staff?user_id=eq.${me.body.id}&select=display_name,role,is_active`)
  const callerRow = Array.isArray(caller.body) ? caller.body[0] : null
  if (!callerRow || !callerRow.is_active || callerRow.role !== 'owner') return fail(403, 'owner_only')

  let input: Record<string, unknown>
  try {
    input = await req.json()
  } catch {
    return fail(400, 'invalid_request')
  }

  if (input.action === 'create') {
    const login = typeof input.login === 'string' ? input.login : ''
    const email = toLoginEmail(login)
    const name = typeof input.display_name === 'string' ? input.display_name.trim().replace(/\s+/g, ' ') : ''
    const role = input.role
    if (!EMAIL_RE.test(email)) return fail(400, 'invalid_login')
    if (name.length < 1 || name.length > 60) return fail(400, 'invalid_name')
    if (role !== 'owner' && role !== 'kitchen') return fail(400, 'invalid_role')
    if (!validPassword(input.password)) return fail(400, 'weak_password')

    const created = await call('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email, password: input.password, email_confirm: true }),
    })
    if (!created.ok) {
      const msg = String(created.body?.msg ?? created.body?.message ?? created.body?.error_code ?? '')
      if (created.status === 422 && /already|exists|registered/i.test(msg)) return fail(409, 'login_taken')
      if (/password/i.test(msg)) return fail(400, 'weak_password')
      return fail(400, 'invalid_login')
    }
    const userId = created.body.id as string

    const staff = await call('/rest/v1/staff', {
      method: 'POST',
      key: ANON,
      token: jwt,
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: userId, display_name: name, role }),
    })
    if (!staff.ok) {
      await call(`/auth/v1/admin/users/${userId}`, { method: 'DELETE' })
      return fail(staff.status === 403 ? 403 : 400, 'could_not_add_staff')
    }
    return reply(200, { user_id: userId, email })
  }

  if (input.action === 'reset_password') {
    const userId = typeof input.user_id === 'string' ? input.user_id : ''
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return fail(400, 'invalid_request')
    if (!validPassword(input.password)) return fail(400, 'weak_password')
    const target = await call(`/rest/v1/staff?user_id=eq.${userId}&select=display_name`)
    const targetRow = Array.isArray(target.body) ? target.body[0] : null
    if (!targetRow) return fail(404, 'not_staff')

    const updated = await call(`/auth/v1/admin/users/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ password: input.password }),
    })
    if (!updated.ok) return fail(400, 'weak_password')

    await call('/rest/v1/audit_log', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        actor: me.body.id,
        actor_name: callerRow.display_name,
        action: 'staff.password_reset',
        entity: 'staff',
        entity_id: userId,
        label: targetRow.display_name,
        changes: {},
      }),
    })
    return reply(200, { ok: true })
  }

  return fail(400, 'invalid_request')
})
