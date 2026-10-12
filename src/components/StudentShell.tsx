import type { ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { isDemo } from '../backend'
import { LANGS, useT } from '../i18n'
import type { Lang } from '../lib/types'
import { IconArrowLeft, IconReceipt } from './icons'
import { Wordmark } from './ui'

export function DemoRibbon() {
  const { t } = useT()
  if (!isDemo) return null
  return <div className="no-print bg-brand px-4 py-1.5 text-center text-xs font-bold text-ink">{t('demo.ribbon')}</div>
}

/** English / हिन्दी / తెలుగు. A native select: big touch target, works with every screen reader. */
export function LanguageSelect() {
  const { lang, setLang, t } = useT()
  return (
    <label className="relative inline-flex min-h-11 items-center">
      <span className="sr-only">{t('lang.label')}</span>
      <select
        value={lang}
        onChange={(e) => setLang(e.target.value as Lang)}
        className="h-9 appearance-none rounded-full border border-white/25 bg-transparent py-0 pr-7 pl-3 text-sm font-bold text-white focus:outline-2 focus:outline-brand [&>option]:text-ink"
      >
        {LANGS.map((l) => (
          <option key={l.value} value={l.value}>{l.label}</option>
        ))}
      </select>
      <svg aria-hidden="true" viewBox="0 0 24 24" className="pointer-events-none absolute right-2.5 size-3.5 text-white/80" fill="none" stroke="currentColor" strokeWidth="3"><path d="m6 9 6 6 6-6" /></svg>
    </label>
  )
}

/** Header for student pages. */
export function StudentHeader({ back, title, right }: { back?: string; title?: string; right?: ReactNode }) {
  const { t } = useT()
  return (
    <header className="vt-header sticky top-0 z-30 bg-ink text-white">
      <div className="mx-auto flex h-16 max-w-3xl items-center gap-2 px-4">
        {back ? (
          <Link to={back} viewTransition className="-ml-2 grid size-11 shrink-0 place-items-center rounded-full hover:bg-white/10" aria-label={t('header.back')}>
            <IconArrowLeft />
          </Link>
        ) : null}
        {title ? (
          <h1 className="min-w-0 flex-1 truncate text-lg font-extrabold">{title}</h1>
        ) : (
          <Link to="/" viewTransition className="min-w-0 flex-1" aria-label="Bite & Sip menu">
            <Wordmark onDark className="text-base" />
          </Link>
        )}
        <LanguageSelect />
        {right ?? (
          <NavLink to="/orders" viewTransition className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-sm font-bold text-white hover:bg-white/10">
            <IconReceipt size={18} />
            <span className={title ? 'sr-only' : 'max-[380px]:sr-only'}>{t('header.myOrders')}</span>
          </NavLink>
        )}
      </div>
    </header>
  )
}
