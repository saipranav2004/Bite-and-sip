import { useEffect, useMemo, useState } from 'react'
import { cafeClock } from '../lib/offers'

/** The café clock, refreshed every 30 s so offers start and end on time. */
export function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(timer)
  }, [])
  return useMemo(() => cafeClock(new Date(now)), [now])
}
