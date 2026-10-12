// Browser side of push notifications and the installable app.
import type { PushSubscriptionJson } from './types'

export function pushSupported() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

export function isIos() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

/** Running as an installed app (home-screen icon), not in a browser tab. */
export function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
}

/** iPhones only allow web push for apps added to the home screen (iOS 16.4+). */
export function needsInstallForPush() {
  return isIos() && !isStandalone()
}

export function permission(): NotificationPermission | 'unsupported' {
  return pushSupported() ? Notification.permission : 'unsupported'
}

let registration: Promise<ServiceWorkerRegistration | null> | null = null

export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return Promise.resolve(null)
  registration ??= navigator.serviceWorker.register('/sw.js').catch(() => null)
  return registration
}

async function readyRegistration() {
  if (!('serviceWorker' in navigator)) return null
  if (import.meta.env.DEV) {
    // Dev server: register on demand so push can still be tried locally.
    await navigator.serviceWorker.register('/sw.js').catch(() => null)
  } else {
    await registerServiceWorker()
  }
  return navigator.serviceWorker.ready
}

function keyBytes(base64url: string) {
  const b64 = base64url.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (base64url.length % 4)) % 4)
  const raw = atob(b64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null
  const reg = await readyRegistration()
  return (await reg?.pushManager.getSubscription()) ?? null
}

/**
 * Asks for permission (must run from a tap) and returns this browser's
 * subscription. Throws 'blocked' when the user said no.
 */
export async function subscribe(publicKey: string): Promise<PushSubscriptionJson> {
  if (!pushSupported()) throw new Error('unsupported')
  const result = await Notification.requestPermission()
  if (result !== 'granted') throw new Error('blocked')
  const reg = await readyRegistration()
  if (!reg) throw new Error('unsupported')
  let sub = await reg.pushManager.getSubscription()
  const wanted = keyBytes(publicKey)
  // A subscription made with a different server key can't receive our messages.
  if (sub) {
    const existing = sub.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null
    if (!existing || existing.length !== wanted.length || existing.some((b, i) => b !== wanted[i])) {
      await sub.unsubscribe()
      sub = null
    }
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted })
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('unsupported')
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } }
}

// ---- Install prompt (Android / desktop Chrome) ------------------------------
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: InstallPromptEvent | null = null
const installListeners = new Set<() => void>()

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as InstallPromptEvent
    installListeners.forEach((l) => l())
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    installListeners.forEach((l) => l())
  })
}

export function canPromptInstall() {
  return !!deferred
}

export function onInstallChange(cb: () => void): () => void {
  installListeners.add(cb)
  return () => {
    installListeners.delete(cb)
  }
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false
  const e = deferred
  deferred = null
  await e.prompt()
  const choice = await e.userChoice
  installListeners.forEach((l) => l())
  return choice.outcome === 'accepted'
}

/** Owner pages install as their own app that opens on the orders board. */
export function setManifest(href: '/manifest.webmanifest' | '/manifest-staff.webmanifest') {
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')
  if (link && link.getAttribute('href') !== href) link.setAttribute('href', href)
}
