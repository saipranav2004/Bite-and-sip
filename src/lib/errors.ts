// Maps backend error codes (raised by the database functions) to friendly copy.
const MESSAGES: Record<string, string> = {
  cafe_closed: 'The café is closed right now, so orders are paused.',
  upi_unavailable: 'UPI is not available right now. Please choose cash.',
  item_unavailable: 'Something in your cart just sold out. Please review your cart.',
  addon_unavailable: 'An add-on in your cart is no longer available. Please review your cart.',
  item_not_found: 'An item in your cart is no longer on the menu. Please review your cart.',
  invalid_items: 'Your cart could not be read. Please review it and try again.',
  invalid_quantity: 'Please check the quantities (up to 20 of each item, 50 items per order).',
  invalid_addons: 'Please check the add-ons you selected.',
  invalid_note: 'Notes can be up to 120 characters.',
  invalid_name: 'Please enter your name.',
  invalid_phone: 'Enter a valid 10-digit Indian mobile number.',
  invalid_payment_method: 'Please choose how you will pay.',
  too_many_open_orders: 'You already have 3 orders in progress. Please collect them before ordering more.',
  invalid_request: 'Something went wrong with this order. Please try again.',
  order_not_found: 'We couldn’t find this order on this device.',
  cannot_cancel: 'This order can no longer be cancelled here. Please speak to the counter.',
  not_allowed: 'You don’t have permission to do that.',
  owner_only: 'Only the owner can do that.',
  invalid_transition: 'This order was already updated. The board has been refreshed.',
  payment_required: 'Confirm the payment before handing over the order.',
  cancel_reason_required: 'Please give a reason for cancelling.',
  order_cancelled: 'This order is cancelled.',
  reference_requires_paid: 'Add a reference only when marking the order paid.',
  kitchen_can_only_change_availability: 'Kitchen accounts can only change availability.',
  cannot_change_own_role_or_status: 'You can’t change your own role or deactivate yourself.',
  invalid_range: 'Choose a valid date range (up to 92 days for sales, a year for profit & loss).',
  insufficient_stock: 'There isn’t enough stock for that.',
  stock_not_tracked: 'Stock isn’t tracked for this item. Turn tracking on first.',
  note_required: 'Add a short note explaining the correction.',
  invalid_cost: 'Enter the cost in whole rupees.',
  weak_password: 'Use a password of at least 8 characters.',
  wrong_password: 'Your current password is incorrect.',
  ingredient_exists: 'You already have an ingredient with that name.',
  ingredient_not_found: 'That ingredient no longer exists. Refresh and try again.',
  unit_family_locked: 'An ingredient can’t switch between weight, volume and pieces. Add a new ingredient instead.',
  invalid_recipe: 'Check the recipe: every line needs an ingredient and a quantity above zero.',
  invalid_amount: 'Enter the price in whole rupees.',
  not_signed_in: 'Your session has expired. Please sign in again.',
  conflict: 'Someone else updated this order first. The board has been refreshed.',
  prices_changed: 'Prices just changed. Please check your cart and place the order again.',
  invalid_pickup_time: 'Choose a pickup time at least 15 minutes from now, later today.',
  feedback_closed: 'Feedback is closed for this order.',
  invalid_rating: 'Choose 1 to 5 stars.',
  table_not_found: 'This table isn’t set up. Please call staff at the counter.',
  too_many_requests: 'You’ve called staff several times — they’re on the way.',
  invalid_subscription: 'This browser’s notification details weren’t accepted. Try again.',
  push_unavailable: 'Notifications aren’t available here.',
  invalid_kitchen_link: 'This kitchen screen link is no longer valid. Ask the owner for the new link.',
  not_found: 'That no longer exists. Refresh and try again.',
  network: 'You seem to be offline. Check your connection and try again.',
  invalid_credentials: 'Email or password is incorrect.',
  not_staff: 'This account doesn’t have staff access. Ask the owner to add you.',
}

export class AppError extends Error {
  code: string
  constructor(code: string, message?: string) {
    super(message ?? MESSAGES[code] ?? 'Something went wrong. Please try again.')
    this.code = code
  }
}

export function friendlyError(err: unknown): string {
  if (err instanceof AppError) return err.message
  if (err instanceof Error && MESSAGES[err.message]) return MESSAGES[err.message]
  if (typeof navigator !== 'undefined' && !navigator.onLine) return MESSAGES.network
  return 'Something went wrong. Please try again.'
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err
  const raw = err as { message?: string; code?: string; details?: string | null; hint?: string | null } | null
  const msg = raw?.message ?? ''
  // Stock errors name the item (details) and, when some is left, how many (hint).
  if (msg === 'insufficient_stock' && raw?.details) {
    return new AppError(msg, `Only ${raw.hint ?? 'a few'} ${raw.details} left. Please lower the quantity.`)
  }
  if (msg === 'prices_changed' && raw?.hint) {
    return new AppError(msg, `Prices just changed — your new total is ₹${raw.hint}. Please check your cart and place the order again.`)
  }
  if (msg === 'item_unavailable' && raw?.details) {
    return new AppError(msg, `${raw.details} just sold out. Please remove it from your cart.`)
  }
  if (MESSAGES[msg]) return new AppError(msg)
  if (/fetch|network|Failed to fetch|Load failed/i.test(msg)) return new AppError('network')
  if (raw?.code === '42501') return new AppError('not_allowed')
  if (raw?.code === '23505') return new AppError('duplicate', 'That name is already in use.')
  if (raw?.code === '23503') return new AppError('in_use', 'This is still in use and can’t be deleted.')
  if (raw?.code === '23514') return new AppError('invalid', 'Please check the values you entered.')
  return new AppError('unknown')
}
