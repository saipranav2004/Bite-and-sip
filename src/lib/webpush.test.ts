// @vitest-environment node
// Checks the push function's encryption and signing against an independent
// implementation (node:crypto) and the worked example in RFC 8291.
import { createDecipheriv, createECDH, generateKeyPairSync, hkdfSync, randomBytes, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { staffNotice, studentNotice } from '../../supabase/functions/push/messages'
import { b64url, encryptPayload, fromB64url, vapidAuthorization } from '../../supabase/functions/push/webpush'

const enc = new TextEncoder()

function decrypt(body: Uint8Array, uaEcdh: ReturnType<typeof createECDH>, auth: Buffer) {
  const buf = Buffer.from(body)
  const salt = buf.subarray(0, 16)
  const rs = buf.readUInt32BE(16)
  const idlen = buf[20]
  const asPublic = buf.subarray(21, 21 + idlen)
  const ct = buf.subarray(21 + idlen)
  const shared = uaEcdh.computeSecret(asPublic)
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), uaEcdh.getPublicKey(), asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const d = createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(ct.subarray(ct.length - 16))
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
  return { rs, idlen, delimiter: plain[plain.length - 1], text: plain.subarray(0, plain.length - 1).toString() }
}

describe('web push encryption (RFC 8291)', () => {
  it('produces a message the browser can decrypt', async () => {
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    const auth = randomBytes(16)
    const message = JSON.stringify({ title: 'आपका ऑर्डर BS-1024 तैयार है', body: 'Table T3' })
    const body = await encryptPayload(enc.encode(message), { p256dh: b64url(ua.getPublicKey()), auth: b64url(auth) })
    const out = decrypt(body, ua, auth)
    expect(out).toEqual({ rs: 4096, idlen: 65, delimiter: 2, text: message })
  })

  it('uses a fresh key and salt for every message', async () => {
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    const target = { p256dh: b64url(ua.getPublicKey()), auth: b64url(randomBytes(16)) }
    const a = await encryptPayload(enc.encode('x'), target)
    const b = await encryptPayload(enc.encode('x'), target)
    expect(Buffer.from(a.subarray(0, 86)).equals(Buffer.from(b.subarray(0, 86)))).toBe(false)
  })

  it('matches the worked example in RFC 8291 §5', async () => {
    const asPublic = fromB64url('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8')
    const jwk = { kty: 'EC', crv: 'P-256', x: b64url(asPublic.slice(1, 33)), y: b64url(asPublic.slice(33)), ext: true }
    const localKeys = {
      privateKey: await crypto.subtle.importKey('jwk', { ...jwk, d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw' }, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
      publicKey: await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
    }
    const body = await encryptPayload(
      enc.encode('When I grow up, I want to be a watermelon'),
      { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
      { salt: fromB64url('DGv6ra1nlYgDCS1FRnbzlw'), localKeys },
    )
    expect(b64url(body)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    )
  })

  it('rejects malformed subscription keys', async () => {
    await expect(encryptPayload(enc.encode('x'), { p256dh: 'abc', auth: 'abc' })).rejects.toThrow()
  })
})

describe('VAPID (RFC 8292)', () => {
  it('signs a JWT for the push service origin that verifies with the public key', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const pub = publicKey.export({ format: 'jwk' })
    const priv = privateKey.export({ format: 'jwk' })
    const raw = Buffer.concat([Buffer.from([4]), Buffer.from(fromB64url(pub.x!)), Buffer.from(fromB64url(pub.y!))])
    const keys = { publicKey: b64url(raw), privateKey: priv.d!, subject: 'https://bite-and-sip.example' }
    const now = Date.UTC(2026, 9, 12, 12)
    const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc:def', keys, now)
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!
    expect(m).not.toBeNull()
    expect(m[4]).toBe(keys.publicKey)
    expect(JSON.parse(Buffer.from(fromB64url(m[1])).toString())).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(JSON.parse(Buffer.from(fromB64url(m[2])).toString())).toEqual({
      aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'https://bite-and-sip.example',
    })
    const ok = verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(fromB64url(m[3])))
    expect(ok).toBe(true)
  })
})

describe('notification texts', () => {
  it('tells the owner what to make and where it goes', () => {
    const n = staffNotice({ event: 'order_placed', order_no: 1024, total: 120, payment_method: 'upi', table_label: 'T3', items: '2× Masala Chai, 1× Maggi' })!
    expect(n.title).toBe('New order BS-1024 · ₹120 UPI')
    expect(n.body).toBe('Table T3\n2× Masala Chai, 1× Maggi')
    expect(n.sticky).toBe(true)
    const pre = staffNotice({ event: 'order_placed', order_no: 7, total: 40, payment_method: 'cash', table_label: null, scheduled_for: '2026-10-12T05:30:00Z', items: '1× Maggi' })!
    expect(pre.body).toBe('Counter pickup · pre-order for 11:00 am\n1× Maggi')
    expect(staffNotice({ event: 'service_request', table_label: 'T5', kind: 'water' })!.title).toBe('Table T5: Water, please')
  })

  it('tells the student in their language', () => {
    const e = { event: 'order_ready' as const, order_id: 'x', order_no: 1024, table_label: null }
    expect(studentNotice(e, 'en')!.body).toBe('Please collect it at the counter.')
    expect(studentNotice(e, 'hi')!.title).toBe('आपका ऑर्डर BS-1024 तैयार है')
    expect(studentNotice({ ...e, table_label: 'T3' }, 'te')!.body).toContain('T3')
    expect(studentNotice(e, 'en')!.url).toBe('/order/x')
  })
})
