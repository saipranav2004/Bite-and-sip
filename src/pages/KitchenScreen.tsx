// Kitchen display for a tablet or TV in the kitchen. Opened with the secret link
// from Settings — no login, no prices, no phone numbers. Cooks can only start an
// order and mark it ready; payments stay with the owner.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { backend } from '../backend'
import type { LiveStatus } from '../backend/types'
import { IconBell, IconClock, IconPin } from '../components/icons'
import { Spinner } from '../components/ui'
import { Chime } from '../hooks/useStaffOrders'
import { toAppError } from '../lib/errors'
import { minutesSince, orderCode } from '../lib/format'
import { isDue, slotLabel } from '../lib/schedule'
import type { KitchenBoard, KitchenTicket } from '../lib/types'

export function KitchenScreen() {
  const { key = '' } = useParams()
  const [board, setBoard] = useState<KitchenBoard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState<LiveStatus>('connecting')
  const [now, setNow] = useState(() => Date.now())
  const [started, setStarted] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const chime = useRef(new Chime())
  const seen = useRef<Set<string> | null>(null)

  const load = useCallback(async () => {
    try {
      const b = await backend.kitchenBoard(key)
      const due = b.orders.filter((o) => o.status === 'placed' && isDue(o.scheduled_for))
      if (seen.current && due.some((o) => !seen.current!.has(o.id))) chime.current.play()
      seen.current = new Set(due.map((o) => o.id))
      setBoard(b)
      setError(null)
    } catch (e) {
      const err = toAppError(e)
      setError(err.code === 'invalid_kitchen_link' ? 'invalid' : err.message)
    }
  }, [key])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), live === 'live' ? 30000 : 8000)
    return () => clearInterval(timer)
  }, [load, live])

  const topic = board?.topic
  useEffect(() => {
    if (!topic) return
    return backend.watchKitchen(topic, () => void load(), setLive)
  }, [topic, load])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 20000)
    document.title = 'Kitchen · Bite & Sip'
    return () => clearInterval(t)
  }, [])

  // Keep the tablet's screen on while the board is open.
  useEffect(() => {
    if (!started) return
    let lock: { release(): Promise<void> } | null = null
    const request = async () => {
      try {
        lock = await (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') ?? null
      } catch {
        lock = null
      }
    }
    void request()
    const onVisible = () => document.visibilityState === 'visible' && void request()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      void lock?.release().catch(() => {})
    }
  }, [started])

  async function advance(t: KitchenTicket, to: 'preparing' | 'ready') {
    setBusy(t.id)
    try {
      await backend.kitchenAdvance(key, t.id, to)
    } catch {
      /* someone else moved it; the reload shows the truth */
    } finally {
      setBusy(null)
      void load()
    }
  }

  if (error === 'invalid') {
    return (
      <Shell>
        <div className="grid min-h-dvh place-items-center p-8 text-center">
          <div>
            <h1 className="text-3xl font-extrabold">This kitchen link no longer works</h1>
            <p className="mt-3 text-lg text-white/70">The owner made a new one or turned it off. Ask for the new link (Settings → Kitchen screen).</p>
          </div>
        </div>
      </Shell>
    )
  }
  if (!board) {
    return (
      <Shell>
        <div className="grid min-h-dvh place-items-center">{error ? <p className="text-xl">{error}</p> : <Spinner label="Loading kitchen orders" />}</div>
      </Shell>
    )
  }

  const due = board.orders.filter((o) => o.status === 'placed' && isDue(o.scheduled_for, now))
  const later = board.orders.filter((o) => o.status === 'placed' && !isDue(o.scheduled_for, now))
  const cooking = board.orders.filter((o) => o.status === 'preparing')
  const ready = board.orders.filter((o) => o.status === 'ready').slice(-8).reverse()

  return (
    <Shell>
      {!started && (
        <button
          type="button"
          onClick={async () => {
            await chime.current.unlock()
            chime.current.play()
            setStarted(true)
            try {
              await document.documentElement.requestFullscreen?.()
            } catch {
              /* fullscreen is optional */
            }
          }}
          className="fixed inset-0 z-50 grid place-items-center bg-ink/95 text-center"
        >
          <span>
            <span className="mx-auto grid size-20 place-items-center rounded-full bg-brand text-ink"><IconBell size={36} /></span>
            <span className="mt-5 block text-3xl font-extrabold">Tap to start the kitchen screen</span>
            <span className="mt-2 block text-lg text-white/70">Turns on the sound for new orders and keeps the screen awake.</span>
          </span>
        </button>
      )}
      <header className="flex items-center gap-4 border-b border-white/10 px-5 py-3">
        <h1 className="text-2xl font-extrabold">{board.cafe_name} · Kitchen</h1>
        <span className="inline-flex items-center gap-2 text-sm text-white/70">
          <span className={`size-2.5 rounded-full ${live === 'live' ? 'bg-ready' : 'animate-pulse bg-brand'}`} aria-hidden="true" />
          {live === 'live' ? 'Live' : 'Reconnecting…'}
        </span>
        <span className="ml-auto text-sm text-white/60">Tap a ticket’s button to move it along. Payments are handled at the counter.</span>
      </header>

      {later.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-5 py-2 text-sm">
          <span className="inline-flex items-center gap-1.5 font-bold text-white/70"><IconClock size={16} /> Later:</span>
          {later.map((o) => (
            <span key={o.id} className="rounded-full bg-white/10 px-3 py-1 font-bold">
              {orderCode(o.order_no)} for {slotLabel(o.scheduled_for!)}
            </span>
          ))}
        </div>
      )}

      <div className="grid gap-4 p-4 lg:grid-cols-[1fr_1fr_0.7fr]">
        <Column title="To make" count={due.length} tone="bg-brand text-ink">
          {due.length === 0 && <Empty>No new orders.</Empty>}
          {due.map((t) => (
            <Ticket key={t.id} t={t} now={now} action="Start" busy={busy === t.id} onAction={() => void advance(t, 'preparing')} />
          ))}
        </Column>
        <Column title="Cooking" count={cooking.length} tone="bg-preparing text-white">
          {cooking.length === 0 && <Empty>Nothing on the stove.</Empty>}
          {cooking.map((t) => (
            <Ticket key={t.id} t={t} now={now} action="Ready" busy={busy === t.id} onAction={() => void advance(t, 'ready')} />
          ))}
        </Column>
        <Column title="Ready" count={ready.length} tone="bg-ready text-white">
          {ready.length === 0 && <Empty>—</Empty>}
          {ready.map((t) => (
            <div key={t.id} className="flex items-center justify-between rounded-xl bg-white/5 px-4 py-3">
              <span className="tabular text-2xl font-extrabold">{orderCode(t.order_no)}</span>
              <span className="font-bold text-white/70">{t.table_label ? `Table ${t.table_label}` : t.customer_name}</span>
            </div>
          ))}
        </Column>
      </div>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-[#0b0b0b] text-white">{children}</div>
}

function Column({ title, count, tone, children }: { title: string; count: number; tone: string; children: React.ReactNode }) {
  return (
    <section aria-label={title}>
      <h2 className="mb-3 flex items-center gap-2 text-lg font-extrabold uppercase">
        {title} <span className={`tabular rounded-full px-2.5 py-0.5 text-base ${tone}`}>{count}</span>
      </h2>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-2xl border border-dashed border-white/20 px-4 py-10 text-center text-white/50">{children}</p>
}

function Ticket({ t, now, action, busy, onAction }: { t: KitchenTicket; now: number; action: string; busy: boolean; onAction: () => void }) {
  const since = t.status === 'preparing' ? t.preparing_at ?? t.created_at : t.scheduled_for ? new Date(Date.parse(t.scheduled_for) - 15 * 60000).toISOString() : t.created_at
  const mins = minutesSince(since, now)
  const [warn, late] = t.status === 'placed' ? [3, 6] : [10, 18]
  const timer = mins >= late ? 'bg-danger text-white' : mins >= warn ? 'bg-brand text-ink' : 'bg-white/10 text-white'
  return (
    <article className="overflow-hidden rounded-2xl bg-white text-ink">
      <header className="flex items-center gap-3 bg-ink px-4 py-2.5 text-white">
        <span className="tabular text-3xl font-extrabold">{orderCode(t.order_no)}</span>
        {t.table_label ? (
          <span className="inline-flex items-center gap-1 rounded-lg bg-brand px-2.5 py-1 text-lg font-extrabold text-ink"><IconPin size={16} /> {t.table_label}</span>
        ) : (
          <span className="rounded-lg border border-white/40 px-2.5 py-1 text-base font-bold">Counter · {t.customer_name}</span>
        )}
        <span className={`tabular ml-auto rounded-lg px-2.5 py-1 text-lg font-extrabold ${timer}`}>{mins < 1 ? 'Now' : `${mins} min`}</span>
      </header>
      {t.scheduled_for && <p className="bg-brand px-4 py-1 text-sm font-extrabold">Pre-order · ready by {slotLabel(t.scheduled_for)}</p>}
      <ul className="space-y-2 px-4 py-3">
        {t.items.map((l, i) => (
          <li key={i} className="text-xl leading-snug">
            <span className="tabular mr-2 font-extrabold">{l.quantity}×</span>
            <span className="font-bold">{l.name}</span>
            {l.addons.length > 0 && <span className="block pl-9 text-base text-ink-2">+ {l.addons.join(', ')}</span>}
            {l.note && <span className="mt-1 ml-9 block rounded-md bg-brand-soft px-2 py-0.5 text-base font-extrabold">Note: {l.note}</span>}
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={busy}
        onClick={onAction}
        className={`min-h-16 w-full text-2xl font-extrabold disabled:opacity-60 ${action === 'Ready' ? 'bg-ready text-white' : 'bg-brand text-ink'}`}
      >
        {busy ? '…' : action === 'Ready' ? 'Ready ✓' : 'Start cooking'}
      </button>
    </article>
  )
}
