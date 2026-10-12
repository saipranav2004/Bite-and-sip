// Student screens in English, Hindi or Telugu. The choice is remembered on the
// device. Staff screens stay in English.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AppError, toAppError } from '../lib/errors'
import { readJson, writeJson } from '../lib/storage'
import type { Lang } from '../lib/types'
import { en, type MessageKey } from './en'
import { hi } from './hi'
import { te } from './te'

export type { MessageKey }

const KEY = 'bitesip-lang-v1'
export const DICTS: Record<Lang, Record<MessageKey, string>> = { en, hi, te }
export const LANGS: { value: Lang; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'हिन्दी' },
  { value: 'te', label: 'తెలుగు' },
]

export type Vars = Record<string, string | number>
export type Translate = (key: MessageKey, vars?: Vars) => string

export function translate(lang: Lang, key: MessageKey, vars?: Vars): string {
  const text = DICTS[lang][key] ?? en[key] ?? key
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text
}

function storedLang(): Lang {
  const v = readJson<string>(KEY, 'en')
  return v === 'hi' || v === 'te' ? v : 'en'
}

interface I18n {
  lang: Lang
  setLang(l: Lang): void
  t: Translate
  /** A student-facing error message in the chosen language. */
  tError(err: unknown): string
}

const Ctx = createContext<I18n | null>(null)

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(storedLang)
  const setLang = useCallback((l: Lang) => {
    setLangState(l)
    writeJson(KEY, l)
  }, [])

  useEffect(() => {
    document.documentElement.lang = lang === 'en' ? 'en' : `${lang}-IN`
  }, [lang])

  const value = useMemo<I18n>(() => {
    const t: Translate = (key, vars) => translate(lang, key, vars)
    return {
      lang,
      setLang,
      t,
      tError(err) {
        const e = err instanceof AppError ? err : toAppError(err)
        // Messages that carry details (an item name, a new total) are built in English by the
        // backends; only plain codes are translated.
        const key = `err.${e.code}` as MessageKey
        const detailed = e.message !== new AppError(e.code).message
        if (lang !== 'en' && !detailed && key in en) return t(key)
        if (e.code === 'unknown') return t('err.generic')
        return e.message
      },
    }
  }, [lang, setLang])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useT(): I18n {
  const ctx = useContext(Ctx)
  if (!ctx) {
    // Outside the provider (isolated component tests): English.
    const t: Translate = (key, vars) => translate('en', key, vars)
    return { lang: 'en', setLang: () => {}, t, tError: (err) => toAppError(err).message }
  }
  return ctx
}
