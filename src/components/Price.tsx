import { money } from '../lib/format'

/** A price, with the pre-offer price struck through when an offer applies. */
export function Price({ price, was, className = '' }: { price: number; was: number | null; className?: string }) {
  return (
    <span className={`tabular font-bold ${className}`}>
      {was !== null && (
        <>
          <s className="mr-1.5 font-semibold text-subtle" aria-hidden="true">{money(was)}</s>
          <span className="sr-only">{money(was)} →</span>
        </>
      )}
      {money(price)}
    </span>
  )
}
