// New-order alerts on the owner's phone (push notifications) and installing
// the console as an app. Push works with the screen off; the in-page chime
// only plays while the board is open.
import { useCallback, useEffect, useState } from 'react'
import { backend } from '../backend'
import { friendlyError } from '../lib/errors'
import {
  canPromptInstall, currentSubscription, isIos, isStandalone, onInstallChange, permission, promptInstall, pushSupported, subscribe,
} from '../lib/push'
import { IconBell, IconCheck, IconDownload } from './icons'
import { Banner, Button, useToast } from './ui'

type State = 'loading' | 'unavailable' | 'ios_install' | 'off' | 'on' | 'blocked'

export function useStaffPush() {
  const [state, setState] = useState<State>('loading')
  const [key, setKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  const check = useCallback(async () => {
    const k = await backend.pushPublicKey().catch(() => null)
    setKey(k)
    if (!k) return setState('unavailable')
    if (!pushSupported()) return setState(isIos() && !isStandalone() ? 'ios_install' : 'unavailable')
    if (permission() === 'denied') return setState('blocked')
    const sub = await currentSubscription()
    setState(sub && (await backend.staffPushEnabled(sub.endpoint).catch(() => false)) ? 'on' : 'off')
  }, [])

  useEffect(() => {
    void check()
  }, [check])

  const enable = async () => {
    if (!key) return
    setBusy(true)
    try {
      await backend.subscribeStaffPush(await subscribe(key))
      setState('on')
      toast('Alerts on — this phone will ring for new orders', 'success')
    } catch (e) {
      if (e instanceof Error && e.message === 'blocked') setState('blocked')
      else toast(friendlyError(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    setBusy(true)
    try {
      const sub = await currentSubscription()
      if (sub) await backend.unsubscribePush(sub.endpoint)
      setState('off')
      toast('Alerts turned off on this phone')
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return { state, busy, enable, disable }
}

/** Shown on the orders board until alerts are on (or dismissed for this session). */
export function AlertsNudge() {
  const { state, busy, enable } = useStaffPush()
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem('bitesip-alerts-nudge') === '1'
    } catch {
      return false
    }
  })
  if (hidden || (state !== 'off' && state !== 'ios_install')) return null
  const hide = () => {
    setHidden(true)
    try {
      sessionStorage.setItem('bitesip-alerts-nudge', '1')
    } catch {
      /* ignore */
    }
  }
  return (
    <Banner
      tone="info"
      className="mb-4"
      title="Get new-order alerts even when the screen is off"
      action={
        <div className="flex gap-2">
          {state === 'off' && <Button size="sm" variant="dark" loading={busy} onClick={() => void enable()}><IconBell size={15} /> Turn on alerts</Button>}
          <Button size="sm" variant="ghost" onClick={hide}>Not now</Button>
        </div>
      }
    >
      {state === 'ios_install'
        ? 'On iPhone: tap Share → “Add to Home Screen”, open the console from the new icon, then turn on alerts here.'
        : 'Your phone shows a notification for every new order, payment claim and table request.'}
    </Banner>
  )
}

/** Settings: alerts on this device, plus installing the console as an app. */
export function AlertsSettings() {
  const { state, busy, enable, disable } = useStaffPush()
  const [installable, setInstallable] = useState(canPromptInstall())
  useEffect(() => onInstallChange(() => setInstallable(canPromptInstall())), [])
  const installed = isStandalone()

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`grid size-10 place-items-center rounded-full ${state === 'on' ? 'bg-ready text-white' : 'bg-sunken text-ink'}`}>
          {state === 'on' ? <IconCheck size={18} strokeWidth={3} /> : <IconBell size={18} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-bold">
            {state === 'on' ? 'Alerts are on for this device' : state === 'loading' ? 'Checking…' : 'Alerts are off for this device'}
          </p>
          <p className="text-sm text-muted">
            {state === 'unavailable' && 'Notifications aren’t set up for this café yet, or this browser doesn’t support them.'}
            {state === 'ios_install' && 'iPhone: add the console to your Home Screen first (Share → Add to Home Screen), then open it from there.'}
            {state === 'blocked' && 'Notifications are blocked for this site. Allow them in the browser’s site settings, then come back.'}
            {(state === 'off' || state === 'on') && 'New orders, “I’ve paid” claims and table requests ring this phone, even when it’s locked.'}
          </p>
        </div>
        {state === 'off' && <Button variant="dark" loading={busy} onClick={() => void enable()}>Turn on</Button>}
        {state === 'on' && <Button variant="secondary" loading={busy} onClick={() => void disable()}>Turn off</Button>}
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <span className="grid size-10 place-items-center rounded-full bg-sunken"><IconDownload size={18} /></span>
        <div className="min-w-0 flex-1">
          <p className="font-bold">{installed ? 'Installed as an app' : 'Install the console as an app'}</p>
          <p className="text-sm text-muted">
            {installed
              ? 'You’re using the app. It opens straight on the orders board.'
              : isIos()
                ? 'On iPhone: tap Share → “Add to Home Screen”.'
                : 'Opens full screen from your home screen, straight on the orders board.'}
          </p>
        </div>
        {!installed && installable && <Button variant="secondary" onClick={() => void promptInstall()}>Install</Button>}
      </div>
      <p className="text-xs text-muted">
        Tip: alerts use your phone’s notification sound. For a louder ring, open your phone’s notification settings for this app or browser and choose a louder sound.
      </p>
    </div>
  )
}
