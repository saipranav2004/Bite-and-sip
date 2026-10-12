import { describe, expect, it } from 'vitest'
import { baseOf, formatQty, formatUnitCost, fromBase, toBase, unitsFor } from './units'

describe('units', () => {
  it('converts to and from base units', () => {
    expect(toBase(1.5, 'kg')).toBe(1500)
    expect(toBase(250, 'g')).toBe(250)
    expect(toBase(2, 'L')).toBe(2000)
    expect(toBase(2, 'dozen')).toBe(24)
    expect(toBase(0.1234, 'kg')).toBe(123.4)
    expect(fromBase(1500, 'kg')).toBe(1.5)
    expect(baseOf('L')).toBe('ml')
    expect(unitsFor('g').map((u) => u.value)).toEqual(['kg', 'g'])
  })

  it('formats quantities the way people read them', () => {
    expect(formatQty(1500, 'kg')).toBe('1.5 kg')
    expect(formatQty(750, 'kg')).toBe('750 g')
    expect(formatQty(-200, 'L')).toBe('−200 ml')
    expect(formatQty(12000, 'L')).toBe('12 L')
    expect(formatQty(24, 'dozen')).toBe('2 dozen')
    expect(formatQty(13, 'dozen')).toBe('13 pieces')
    expect(formatQty(1, 'packet')).toBe('1 packet')
    expect(formatQty(0, 'kg')).toBe('0 kg')
  })

  it('shows cost per the unit people buy in', () => {
    expect(formatUnitCost(0.06, 'L')).toBe('₹60 / L')
    expect(formatUnitCost(0.045, 'kg')).toBe('₹45 / kg')
    expect(formatUnitCost(12, 'packet')).toBe('₹12 / packet')
    expect(formatUnitCost(0.4, 'g')).toBe('₹400 / kg')
    expect(formatUnitCost(0.06, 'ml')).toBe('₹60 / L')
    expect(formatUnitCost(6, 'pcs')).toBe('₹6 / piece')
    expect(formatUnitCost(null, 'kg')).toBeNull()
  })
})
