import { useCallback, useEffect, useRef, useState } from 'react'
import { backend } from '../backend'
import type { ServiceRequest } from '../lib/types'

/** Open "call staff" requests, live, with polling as a fallback. */
export function useServiceRequests(onNew?: (r: ServiceRequest[]) => void) {
  const [requests, setRequests] = useState<ServiceRequest[]>([])
  const seen = useRef<Set<string> | null>(null)
  const onNewRef = useRef(onNew)
  useEffect(() => {
    onNewRef.current = onNew
  }, [onNew])

  const load = useCallback(async () => {
    try {
      const list = await backend.listServiceRequests()
      if (seen.current) {
        const fresh = list.filter((r) => !seen.current!.has(r.id))
        if (fresh.length) onNewRef.current?.(fresh)
      }
      seen.current = new Set(list.map((r) => r.id))
      setRequests(list)
    } catch {
      /* keep the last list; the next poll retries */
    }
  }, [])

  useEffect(() => {
    void load()
    const stop = backend.watchServiceRequests(() => void load())
    const timer = setInterval(() => void load(), 20000)
    return () => {
      stop()
      clearInterval(timer)
    }
  }, [load])

  const resolve = useCallback(async (id: string) => {
    setRequests((rs) => rs.filter((r) => r.id !== id))
    await backend.resolveServiceRequest(id)
    void load()
  }, [load])

  return { requests, resolve, reload: load }
}

export const HELP_LABEL: Record<ServiceRequest['kind'], string> = {
  water: 'Water',
  cutlery: 'Spoon / plate',
  clean: 'Clean the table',
  bill: 'Wants to pay',
  help: 'Needs help',
}
