import { describe, expect, it } from 'vitest'
import { en } from './en'
import { DICTS, translate } from './index'

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('translations', () => {
  it('have every key, and the same placeholders, in every language', () => {
    for (const [lang, dict] of Object.entries(DICTS)) {
      expect(Object.keys(dict).sort(), lang).toEqual(Object.keys(en).sort())
      for (const [key, text] of Object.entries(dict)) {
        expect(text.trim().length, `${lang} ${key}`).toBeGreaterThan(0)
        expect(placeholders(text), `${lang} ${key}`).toEqual(placeholders(en[key as keyof typeof en]))
      }
    }
  })

  it('fills in placeholders', () => {
    expect(translate('en', 'menu.tablePill', { table: 'T3' })).toBe('Table T3 · We’ll bring it to you')
    expect(translate('hi', 'cart.place', { total: '₹120' })).toBe('ऑर्डर करें · ₹120')
    expect(translate('te', 'order.atTable', { table: 'T5' })).toBe('టేబుల్ T5')
  })
})
