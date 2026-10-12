// Units for raw materials. Stock is stored in a base unit (g, ml, pcs, packet);
// people type and read the unit they think in (kg, L, dozen…).
export type BaseUnit = 'g' | 'ml' | 'pcs' | 'packet'
export type Unit = 'g' | 'kg' | 'ml' | 'L' | 'pcs' | 'dozen' | 'packet'

export const UNITS: { value: Unit; label: string; base: BaseUnit; factor: number }[] = [
  { value: 'kg', label: 'kg', base: 'g', factor: 1000 },
  { value: 'g', label: 'g', base: 'g', factor: 1 },
  { value: 'L', label: 'litre', base: 'ml', factor: 1000 },
  { value: 'ml', label: 'ml', base: 'ml', factor: 1 },
  { value: 'pcs', label: 'pieces', base: 'pcs', factor: 1 },
  { value: 'dozen', label: 'dozen', base: 'pcs', factor: 12 },
  { value: 'packet', label: 'packets', base: 'packet', factor: 1 },
]

const byValue = new Map(UNITS.map((u) => [u.value, u]))

export const baseOf = (unit: Unit): BaseUnit => byValue.get(unit)!.base

/** Units that measure the same thing (kg ↔ g), for the quantity dropdown. */
export const unitsFor = (base: BaseUnit) => UNITS.filter((u) => u.base === base)

/** 1.5 kg → 1500 (g). Rounded to 3 decimals like the database. */
export function toBase(quantity: number, unit: Unit): number {
  return Math.round(quantity * byValue.get(unit)!.factor * 1000) / 1000
}

export function fromBase(baseQty: number, unit: Unit): number {
  return baseQty / byValue.get(unit)!.factor
}

const num = (n: number, max = 2) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: max }).format(n)

/** "1.5 kg", "750 g", "−200 ml", "3 packets". Small amounts drop to the smaller unit. */
export function formatQty(baseQty: number, display: Unit): string {
  const sign = baseQty < 0 ? '−' : ''
  const abs = Math.abs(baseQty)
  let unit = display
  if ((display === 'kg' || display === 'L') && abs > 0 && abs < 1000) unit = display === 'kg' ? 'g' : 'ml'
  if (display === 'dozen' && abs % 12 !== 0) unit = 'pcs'
  const value = fromBase(abs, unit)
  const label = unit === 'packet' ? (value === 1 ? 'packet' : 'packets') : unit === 'pcs' ? (value === 1 ? 'piece' : 'pieces') : unit
  return `${sign}${num(value, unit === 'g' || unit === 'ml' || unit === 'pcs' ? 1 : 2)} ${label}`
}

/** Price the way it's quoted at the shop: per kg, per litre, per piece/dozen/packet. */
export function formatUnitCost(costPerBase: number | null, display: Unit): string | null {
  if (costPerBase === null || !Number.isFinite(costPerBase)) return null
  const unit: Unit = display === 'g' ? 'kg' : display === 'ml' ? 'L' : display
  const per = costPerBase * byValue.get(unit)!.factor
  return `₹${num(per, per < 10 ? 2 : 0)} / ${unit === 'packet' ? 'packet' : unit === 'pcs' ? 'piece' : unit}`
}

/** Common Indian café raw materials, offered as suggestions — any name can be typed. */
export const INGREDIENT_SUGGESTIONS: { name: string; unit: Unit }[] = [
  { name: 'Milk', unit: 'L' }, { name: 'Tea powder', unit: 'g' }, { name: 'Coffee powder', unit: 'g' }, { name: 'Sugar', unit: 'kg' },
  { name: 'Maida', unit: 'kg' }, { name: 'Atta', unit: 'kg' }, { name: 'Rice', unit: 'kg' }, { name: 'Oil', unit: 'L' },
  { name: 'Butter', unit: 'g' }, { name: 'Cheese slices', unit: 'pcs' }, { name: 'Paneer', unit: 'g' }, { name: 'Eggs', unit: 'pcs' },
  { name: 'Bread', unit: 'packet' }, { name: 'Maggi', unit: 'packet' }, { name: 'Potato', unit: 'kg' }, { name: 'Onion', unit: 'kg' },
  { name: 'Tomato', unit: 'kg' }, { name: 'Green chilli', unit: 'g' }, { name: 'Ginger', unit: 'g' }, { name: 'Cardamom', unit: 'g' },
  { name: 'Lemon', unit: 'pcs' }, { name: 'Soda', unit: 'ml' }, { name: 'Chocolate syrup', unit: 'ml' }, { name: 'Ice cream', unit: 'L' },
  { name: 'Salt', unit: 'kg' }, { name: 'Masala', unit: 'g' }, { name: 'Disposable cups', unit: 'pcs' }, { name: 'Paper plates', unit: 'pcs' },
]
