// Browser storage can throw (private mode, blocked storage) — never let that break ordering.
type Area = 'local' | 'session'
const store = (area: Area) => (area === 'session' ? window.sessionStorage : window.localStorage)

export function readJson<T>(key: string, fallback: T, area: Area = 'local'): T {
  try {
    const raw = store(area).getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function writeJson(key: string, value: unknown, area: Area = 'local') {
  try {
    store(area).setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable: keep working in memory */
  }
}

export function removeKey(key: string) {
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}
