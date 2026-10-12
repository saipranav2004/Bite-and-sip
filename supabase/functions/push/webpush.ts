// Web Push with no dependencies: VAPID (RFC 8292) and aes128gcm payload
// encryption (RFC 8291 / RFC 8188), using only the Web Crypto API.
// Runs in Deno (Supabase Edge Functions) and Node 20+ (tests).

const enc = new TextEncoder()

export function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (s.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export interface VapidKeys {
  /** Uncompressed P-256 public key (65 bytes), base64url. */
  publicKey: string
  /** Private scalar d (32 bytes), base64url. */
  privateKey: string
  /** mailto: or https: contact for the push services. */
  subject: string
}

export interface PushTarget {
  endpoint: string
  p256dh: string
  auth: string
}

async function signingKey(keys: VapidKeys): Promise<CryptoKey> {
  const pub = fromB64url(keys.publicKey)
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID public key must be an uncompressed P-256 point')
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), d: keys.privateKey, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
}

/** The Authorization header value for one push service (audience = its origin). */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, nowMs = Date.now()): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(nowMs / 1000) + 12 * 3600,
    sub: keys.subject,
  })))
  const unsigned = `${header}.${claims}`
  // Web Crypto returns the raw r‖s signature, which is exactly what JWS ES256 uses.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(keys), enc.encode(unsigned)))
  return `vapid t=${unsigned}.${b64url(sig)}, k=${keys.publicKey}`
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8))
}

/** Encrypts one payload for one browser (a single aes128gcm record). */
export async function encryptPayload(
  payload: Uint8Array,
  target: Pick<PushTarget, 'p256dh' | 'auth'>,
  fixed?: { salt?: Uint8Array<ArrayBuffer>; localKeys?: CryptoKeyPair },
): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = fromB64url(target.p256dh)
  const authSecret = fromB64url(target.auth)
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('Invalid subscription keys')
  if (payload.length > 3800) throw new Error('Payload too large')

  const local = fixed?.localKeys ?? (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']))
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey))
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256))

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32)
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  // 0x02 marks the last (only) record; no padding.
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(payload, new Uint8Array([2]))))

  const header = new Uint8Array(16 + 4 + 1 + 65)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, 4096)
  header[20] = 65
  header.set(asPublic, 21)
  return concat(header, cipher)
}

export interface SendOptions {
  /** Seconds the push service keeps the message for an offline device. */
  ttl: number
  urgency?: 'very-low' | 'low' | 'normal' | 'high'
  /** Replaces an undelivered message with the same topic (max 32 url-safe chars). */
  topic?: string
}

/** Sends one notification. Returns the push service's HTTP status (404/410 = subscription gone). */
export async function sendPush(target: PushTarget, message: unknown, keys: VapidKeys, opts: SendOptions): Promise<number> {
  const body = await encryptPayload(enc.encode(JSON.stringify(message)), target)
  const headers: Record<string, string> = {
    Authorization: await vapidAuthorization(target.endpoint, keys),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(opts.ttl),
    Urgency: opts.urgency ?? 'normal',
  }
  if (opts.topic) headers.Topic = opts.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
  const res = await fetch(target.endpoint, { method: 'POST', headers, body })
  await res.body?.cancel()
  return res.status
}
