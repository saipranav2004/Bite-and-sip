// Offers, pre-orders, call staff, feedback, order again, languages, the
// kitchen screen, daily cash closing and the owner's insight pages.
// Runs against the demo backend and against local Supabase (E2E_BACKEND=supabase).
import { expect, test, type Page } from '@playwright/test'
import { BACKEND, OWNER, showStage, signIn, staffPage, uniquePhone } from './helpers'

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => sessionStorage.setItem('bitesip-intro-seen', '1'))
})

async function checkout(page: Page, name: string, method: 'cash' | 'upi' = 'cash') {
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Mobile number').fill(uniquePhone())
  if (method === 'cash') await page.getByText(/^Cash/).first().click()
  else await page.getByText('UPI', { exact: true }).click()
}

async function orderCodeOn(page: Page) {
  return (await page.getByText(/^BS-\d+$/).first().textContent())!.trim()
}

test('offers: a timed discount prices the menu, the cart and the order; pausing it updates the cart before ordering', async ({ page, browser }) => {
  const title = `E2E deal ${Date.now() % 100000}`
  const owner = await staffPage(browser, page)
  await signIn(owner, OWNER)
  await owner.goto('/staff/offers')
  await owner.getByRole('button', { name: 'New offer' }).first().click()
  const editor = owner.getByRole('dialog')
  await editor.getByLabel('Name students see').fill(title)
  await editor.getByLabel('Discount').fill('30')
  await editor.getByRole('checkbox', { name: /Fresh Lime Soda/ }).check()
  await expect(editor.getByText(/Fresh Lime Soda: ₹25 → ₹18/)).toBeVisible()
  await editor.getByRole('button', { name: 'Create offer' }).click()
  await expect(owner.getByText(title)).toBeVisible()
  await expect(owner.getByRole('listitem').filter({ hasText: title }).getByText('Live now')).toBeVisible()

  try {
    await page.goto('/')
    await expect(page.getByText(title).first()).toBeVisible()
    await page.getByRole('button', { name: 'Add Fresh Lime Soda' }).click()
    await page.getByRole('button', { name: /View cart/ }).click()
    await expect(page.getByText('Offer savings')).toBeVisible()
    await expect(page.getByRole('button', { name: /Place order · ₹18/ })).toBeVisible()

    // The owner pauses the offer while the student is checking out.
    await owner.getByRole('switch', { name: `${title} on or off` }).click()
    await expect(owner.getByText(`${title} paused`).first()).toBeVisible()
    await checkout(page, 'Offer Student')
    await page.getByRole('button', { name: /Place order · ₹18/ }).click()
    await expect(page.getByText(/Prices were updated.*₹25/)).toBeVisible()
    await page.getByRole('button', { name: /Place order · ₹25/ }).click()
    await expect(page.getByText('Order received')).toBeVisible()
    await expect(page.getByText(title)).toHaveCount(0)

    // Back on: the next order gets it, and the order page shows the discount.
    await owner.getByRole('switch', { name: `${title} on or off` }).click()
    await expect(owner.getByText(`${title} is on`).first()).toBeVisible()
    await page.goto('/')
    await page.getByRole('button', { name: 'Add Fresh Lime Soda' }).click()
    await page.getByRole('button', { name: /View cart/ }).click()
    await checkout(page, 'Offer Student')
    await page.getByRole('button', { name: /Place order · ₹18/ }).click()
    await expect(page.getByText('Order received')).toBeVisible()
    await expect(page.getByText(`${title} · −₹7 each`)).toBeVisible()
  } finally {
    await owner.goto('/staff/offers')
    await owner.getByRole('button', { name: `Delete ${title}` }).click()
    await owner.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
    await expect(owner.getByText('Offer deleted')).toBeVisible()
  }
})

test('pre-order for later: the student picks a time, the board holds it under “later”', async ({ page, browser }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add Filter Coffee' }).click()
  await page.getByRole('button', { name: /View cart/ }).click()
  const later = page.getByText('Later today', { exact: true })
  test.skip(await page.getByText('No more pickup times today.').isVisible(), 'Too late in the day to pre-order')
  await later.click()
  const time = (await page.getByLabel('Pickup time').locator('option:checked').textContent())!.trim()
  await expect(page.getByText(`It will be ready at the counter at ${time}.`)).toBeVisible()
  await checkout(page, 'Pre Order')
  await page.getByRole('button', { name: /Place order/ }).click()
  await expect(page.getByRole('heading', { name: 'Pre-order received' })).toBeVisible()
  await expect(page.getByText(`Pre-order for ${time}`)).toBeVisible()
  const code = await orderCodeOn(page)

  const owner = await staffPage(browser, page)
  await signIn(owner, OWNER)
  const later_ = owner.getByRole('region', { name: 'Pre-orders for later' })
  await expect(later_.getByText(code)).toBeVisible()
  await showStage(owner, 'New')
  await expect(owner.getByRole('article', { name: new RegExp(`${code} for Pre Order`) })).toHaveCount(0)

  await page.getByRole('button', { name: 'Cancel this order' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel order' }).click()
  await expect(page.getByRole('heading', { name: 'Order cancelled' })).toBeVisible()
  await expect(later_.getByText(code)).toHaveCount(0, { timeout: 15_000 })
})

test('call staff from the table: the owner sees it on the board and marks it done', async ({ page, browser }) => {
  const owner = await staffPage(browser, page)
  await signIn(owner, OWNER)
  // Clear anything left over from earlier runs at this table.
  const done = owner.getByRole('button', { name: /^Done: Table T7/ })
  while (await done.first().isVisible().catch(() => false)) await done.first().click()

  await page.goto('/t/T7')
  await page.getByRole('button', { name: 'Call staff' }).click()
  await page.getByRole('dialog').getByRole('button', { name: /Spoon \/ plate/ }).click()
  await expect(page.getByText('Staff notified — coming to Table T7')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Spoon / plate: on the way' })).toBeVisible()

  const request = owner.getByRole('button', { name: 'Done: Table T7 Spoon / plate' })
  await expect(request).toBeVisible({ timeout: 25_000 })
  await request.click()
  await expect(request).toHaveCount(0)
  // The student's button goes back to normal once staff mark it done.
  await expect(page.getByRole('button', { name: 'Call staff' })).toBeVisible({ timeout: 20_000 })
})

test('after serving: the student rates it, the owner reads it, and “order again” refills the cart', async ({ page, browser }) => {
  const comment = `Great rice ${Date.now() % 10000}`
  await page.goto('/')
  // Veg-only hides non-veg dishes.
  await page.getByRole('button', { name: 'Veg only' }).click()
  await expect(page.getByRole('button', { name: /Egg Fried Rice, ₹90/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Veg only' }).click()
  await page.getByRole('button', { name: 'Add Egg Fried Rice' }).click()
  await page.getByRole('button', { name: /View cart/ }).click()
  await checkout(page, 'Rating Student')
  await page.getByRole('button', { name: /Place order · ₹90/ }).click()
  await expect(page.getByText('Order received')).toBeVisible()
  const code = await orderCodeOn(page)

  const owner = await staffPage(browser, page)
  await signIn(owner, OWNER)
  const card = owner.getByRole('article', { name: new RegExp(`${code} for Rating Student`) })
  await showStage(owner, 'New')
  await card.getByRole('button', { name: 'Start preparing' }).click()
  await showStage(owner, 'Preparing')
  await card.getByRole('button', { name: 'Mark ready' }).click()
  await showStage(owner, 'Ready')
  await card.getByRole('button', { name: /Collect ₹90/ }).click()
  await owner.getByRole('dialog').getByRole('button', { name: /Collected ₹90/ }).click()
  await expect(card).toHaveCount(0)

  await expect(page.getByRole('heading', { name: 'How was it?' })).toBeVisible({ timeout: 15_000 })
  await page.getByRole('radio', { name: '5 stars' }).click()
  await page.getByLabel(/Anything to tell us/).fill(comment)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('You rated this 5/5')).toBeVisible()

  await owner.goto('/staff/feedback')
  await expect(owner.getByText(`“${comment}”`)).toBeVisible()

  await page.getByRole('button', { name: 'Order again' }).click()
  await expect(page.getByRole('heading', { name: 'Your cart' })).toBeVisible()
  await expect(page.getByText('Egg Fried Rice')).toBeVisible()
  await expect(page.getByRole('button', { name: /Place order · ₹90/ })).toBeVisible()
})

test('students can switch the app to Hindi or Telugu; the choice is remembered', async ({ page }) => {
  await page.goto('/t/T3')
  await page.getByLabel('Language').selectOption('hi')
  await expect(page.getByRole('heading', { name: /भूख लगी है\?/ })).toBeVisible()
  await expect(page.getByText('टेबल T3 · हम आप तक लाएँगे')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: /भूख लगी है\?/ })).toBeVisible()
  await page.getByLabel('भाषा').selectOption('te')
  await expect(page.getByRole('heading', { name: /ఆకలిగా ఉందా\?/ })).toBeVisible()
  await page.getByRole('button', { name: 'Masala Chai జోడించు' }).click()
  await page.getByRole('button', { name: /కార్ట్ చూడండి/ }).click()
  await expect(page.getByRole('heading', { name: 'మీ కార్ట్' })).toBeVisible()
  await expect(page.getByRole('button', { name: /ఆర్డర్ చేయండి · ₹15/ })).toBeVisible()
  await page.getByLabel('భాష').selectOption('en')
  await expect(page.getByRole('heading', { name: 'Your cart' })).toBeVisible()
})

test('kitchen screen: a secret link shows tickets without prices and moves them along', async ({ page, browser }) => {
  const owner = await staffPage(browser, page)
  await signIn(owner, OWNER)
  await owner.goto('/staff/settings')
  const create = owner.getByRole('button', { name: 'Create kitchen link' })
  const newLink = owner.getByRole('button', { name: 'Make a new link' })
  await expect(create.or(newLink)).toBeVisible()
  if (await create.isVisible()) await create.click()
  else {
    await newLink.click()
    await owner.getByRole('dialog').getByRole('button', { name: 'New link' }).click()
  }
  const url = (await owner.locator('p.font-mono').textContent())!.trim()
  expect(url).toMatch(/\/kitchen\/[0-9a-f]{36}$/)

  await page.goto('/')
  await page.getByRole('button', { name: 'Add Crispy Samosa' }).click()
  await page.getByRole('button', { name: /View cart/ }).click()
  await checkout(page, 'Kitchen Test')
  await page.getByRole('button', { name: /Place order · ₹15/ }).click()
  await expect(page.getByText('Order received')).toBeVisible()
  const code = await orderCodeOn(page)

  const kitchenCtx = BACKEND === 'demo' ? page.context() : await browser.newContext()
  const kitchen = await kitchenCtx.newPage()
  await kitchen.goto(new URL(url).pathname)
  await kitchen.getByRole('button', { name: /Tap to start the kitchen screen/ }).click()
  const ticket = kitchen.getByRole('article').filter({ hasText: code })
  await expect(ticket).toBeVisible()
  await expect(ticket).not.toContainText('₹')
  await ticket.getByRole('button', { name: 'Start cooking' }).click()
  await expect(page.getByRole('heading', { name: 'Being prepared' })).toBeVisible({ timeout: 15_000 })
  await kitchen.getByRole('article').filter({ hasText: code }).getByRole('button', { name: 'Ready ✓' }).click()
  await expect(page.getByRole('heading', { name: 'Ready for pickup' })).toBeVisible({ timeout: 15_000 })

  // Turning the link off locks the kitchen screen out.
  await owner.getByRole('button', { name: 'Turn off' }).click()
  await owner.getByRole('dialog').getByRole('button', { name: 'Turn off' }).click()
  await expect(owner.getByRole('button', { name: 'Create kitchen link' })).toBeVisible()
  await kitchen.reload()
  await expect(kitchen.getByRole('heading', { name: 'This kitchen link no longer works' })).toBeVisible()
})

test('close the day: expected cash, the count, and the history', async ({ page }) => {
  await signIn(page, OWNER)
  await page.goto('/staff/close-day')
  await page.getByLabel('Cash at the start of the day').fill('500')
  await page.getByLabel('Cash taken out').fill('0')
  const expected = Number((await page.getByText('Should be in the drawer').locator('..').locator('strong').textContent())!.replace(/[^\d]/g, ''))
  expect(expected).toBeGreaterThanOrEqual(500)
  await page.getByLabel('Cash counted now').fill(String(expected - 20))
  await expect(page.getByText('Short by ₹20')).toBeVisible()
  await page.getByLabel('Cash counted now').fill(String(expected))
  await expect(page.getByText('Matches exactly')).toBeVisible()
  await page.getByRole('button', { name: /Close the day|Update closing/ }).click()
  await expect(page.getByText(/Day closed|Closing updated/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Update closing' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Past closings' }).getByRole('row').nth(1)).toContainText('✓')
})

test('insight pages: menu insights, shopping list and usage check load for the owner', async ({ page }) => {
  await signIn(page, OWNER)
  await page.goto('/staff/insights')
  await expect(page.getByRole('heading', { name: 'Menu insights' })).toBeVisible()
  await page.getByRole('button', { name: 'Last 30 days' }).click()
  await expect(page.getByRole('heading', { name: 'Stars' }).or(page.getByText(/No sales in this period/))).toBeVisible()
  await page.goto('/staff/inventory')
  await page.getByRole('tab', { name: 'Shopping list' }).click()
  await expect(page.getByRole('heading', { name: 'Shopping list' })).toBeVisible()
  await expect(page.getByRole('button', { name: '1 week' })).toBeVisible()
  await page.getByRole('tab', { name: 'Usage check' }).click()
  await expect(page.getByRole('heading', { name: 'Expected vs actual use' })).toBeVisible()
})
