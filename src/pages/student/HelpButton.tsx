// "Call staff" for students at a table: water, spoon/plate, clean, bill, other.
import { useCallback, useEffect, useRef, useState } from 'react'
import { backend } from '../../backend'
import { IconBell, IconCheck } from '../../components/icons'
import { Dialog, Spinner, useToast } from '../../components/ui'
import { useT, type MessageKey } from '../../i18n'
import { readJson, writeJson } from '../../lib/storage'
import type { ServiceKind, ServiceRequest } from '../../lib/types'

const KINDS: { kind: ServiceKind; key: MessageKey; emoji: string }[] = [
  { kind: 'water', key: 'help.water', emoji: '💧' },
  { kind: 'cutlery', key: 'help.cutlery', emoji: '🥄' },
  { kind: 'clean', key: 'help.clean', emoji: '🧽' },
  { kind: 'bill', key: 'help.bill', emoji: '🧾' },
  { kind: 'help', key: 'help.help', emoji: '🙋' },
]
const STORE = 'bitesip-help-v1'

function kindKey(kind: ServiceKind) {
  return KINDS.find((k) => k.kind === kind)!.key
}

/** Requests made from this phone in the last 30 minutes. */
function useMyRequests() {
  const [items, setItems] = useState<ServiceRequest[]>(() =>
    readJson<ServiceRequest[]>(STORE, [], 'session').filter((r) => Date.now() - Date.parse(r.created_at) < 30 * 60000),
  )
  const latest = useRef(items)
  const save = useCallback((next: ServiceRequest[]) => {
    latest.current = next
    setItems(next)
    writeJson(STORE, next, 'session')
  }, [])

  // While something is on its way, check every 10 s whether staff marked it done.
  const openIds = items.filter((r) => !r.resolved_at).map((r) => r.id).join(',')
  useEffect(() => {
    if (!openIds) return
    const timer = setInterval(async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const fresh = await backend.serviceRequestStatus(openIds.split(','))
        save(latest.current.map((r) => fresh.find((f) => f.id === r.id) ?? r))
      } catch {
        /* try again on the next tick */
      }
    }, 10000)
    return () => clearInterval(timer)
  }, [openIds, save])

  return { items, save }
}

export function HelpButton({ table, className = '' }: { table: string; className?: string }) {
  const { t, tError } = useT()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<ServiceKind | null>(null)
  const { items, save } = useMyRequests()
  const pending = items.filter((r) => !r.resolved_at)

  async function ask(kind: ServiceKind) {
    setBusy(kind)
    try {
      const r = await backend.requestService(table, kind)
      const known = items.some((x) => x.id === r.id)
      save([...items.filter((x) => x.id !== r.id), r])
      toast(known ? t('help.already') : t('help.sent', { table }), 'success')
      setOpen(false)
    } catch (err) {
      toast(tError(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border border-white/30 px-3 text-sm font-bold text-white hover:bg-white/10 ${className}`}
      >
        <IconBell size={16} />
        {pending.length ? t('help.sentShort', { what: t(kindKey(pending[pending.length - 1].kind)) }) : t('help.button')}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('help.title')} description={t('help.subtitle', { table })} size="sm" closeLabel={t('help.close')}>
        <ul className="grid grid-cols-2 gap-2.5 p-4">
          {KINDS.map(({ kind, key, emoji }) => {
            const mine = items.filter((r) => r.kind === kind).at(-1)
            return (
              <li key={kind} className={kind === 'help' ? 'col-span-2' : ''}>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void ask(kind)}
                  className="flex min-h-20 w-full flex-col items-start justify-between gap-1 rounded-2xl border-2 border-line bg-surface p-3 text-left font-bold transition-colors hover:border-ink disabled:opacity-60"
                >
                  <span className="flex w-full items-center justify-between text-2xl" aria-hidden="true">
                    {emoji}
                    {busy === kind && <Spinner className="size-4" />}
                  </span>
                  <span>{t(key)}</span>
                  {mine && (
                    <span className={`inline-flex items-center gap-1 text-xs ${mine.resolved_at ? 'text-ready' : 'text-brand-ink'}`}>
                      {mine.resolved_at && <IconCheck size={12} strokeWidth={3} />}
                      {mine.resolved_at ? t('help.done', { what: t(key) }) : t('help.sentShort', { what: t(key) })}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      </Dialog>
    </>
  )
}
