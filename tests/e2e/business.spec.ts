// Owner tools: stock, expenses → profit & loss, team logins, audit log.
// Runs against the demo backend and against local Supabase (E2E_BACKEND=supabase).
import { expect, test, type Page } from '@playwright/test'
import { KITCHEN, OWNER, signIn, staffPage, uniquePhone } from './helpers'

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => sessionStorage.setItem('bitesip-intro-seen', '1'))
})

const ITEM = 'Bread Omelette' // ₹35, no add-ons, not used by the ordering tests

/** Amount in a statement row, e.g. "−₹1,200" → -1200. */
async function rowAmount(page: Page, label: string) {
  const row = page.getByRole('region', { name: 'Profit and loss statement' }).getByRole('row', { name: new RegExp(`^${label}`) })
  const text = (await row.getByRole('cell').first().innerText()).trim()
  const n = Number(text.replace(/[^\d]/g, ''))
  return text.startsWith('−') ? -n : n
}

test('stock: owner tracks an item, a student order sells it out, staff restock it, the audit log shows it', async ({ page, browser }) => {
  const owner = await staffPage(browser, page)
  await signIn(owner, OWNER)
  await owner.goto('/staff/inventory')
  await owner.getByRole('button', { name: 'Track an item' }).first().click()
  const setup = owner.getByRole('dialog')
  await setup.getByLabel('Item').selectOption({ label: ITEM })
  await setup.getByLabel('How many are ready now?').fill('2')
  await setup.getByLabel('Warn me when it drops to').fill('2')
  await setup.getByRole('button', { name: 'Start tracking' }).click()
  await expect(owner.getByText(`Tracking ${ITEM}`)).toBeVisible()

  try {
    // Student: the menu warns it's nearly gone, and won't let them take more than is left.
    await page.goto('/')
    await expect(page.getByText('Only 2 left')).toBeVisible()
    await page.getByRole('button', { name: `Add ${ITEM}` }).click()
    await page.getByRole('button', { name: `Increase ${ITEM}` }).click()
    await expect(page.getByRole('button', { name: `Increase ${ITEM}` })).toBeDisabled()
    await page.getByRole('button', { name: /View cart/ }).click()
    await page.getByLabel('Name').fill('Stock Tester')
    await page.getByLabel('Mobile number').fill(uniquePhone())
    await page.getByLabel(/Cash at the counter/).check()
    await page.getByRole('button', { name: /Place order · ₹70/ }).click()
    await expect(page.getByText('Order received')).toBeVisible()
    await page.goto('/')
    await expect(page.getByRole('button', { name: new RegExp(`${ITEM}, ₹35`) }).locator('..').getByText('Sold out')).toBeVisible()

    // Staff: it shows as out of stock; kitchen restocks it.
    await signIn(owner, KITCHEN)
    await owner.goto('/staff/inventory')
    await owner.getByRole('button', { name: /^Out [1-9]/ }).click()
    await owner.getByRole('button', { name: `Adjust stock for ${ITEM}` }).first().click()
    const adjust = owner.getByRole('dialog')
    await adjust.getByText('Received', { exact: true }).click()
    await adjust.getByLabel('Quantity').fill('6')
    await expect(adjust.getByText('→')).toBeVisible()
    await adjust.getByRole('button', { name: 'Add 6 to stock' }).click()
    await expect(owner.getByText(`${ITEM}: 6 in stock`)).toBeVisible()

    // Kitchen can't open money pages.
    await owner.goto('/staff/profit')
    await expect(owner.getByRole('heading', { name: 'Orders' })).toBeVisible()

    // Student can order it again.
    await page.goto('/')
    await expect(page.getByRole('button', { name: `Add ${ITEM}` })).toBeEnabled()

    // Owner: the audit log names who did what.
    await signIn(owner, OWNER)
    await owner.goto('/staff/audit')
    await owner.getByRole('button', { name: 'Stock', exact: true }).click()
    await expect(owner.getByText(new RegExp(`received stock of ${ITEM}`)).first()).toBeVisible()
    await expect(owner.getByText(new RegExp(`started tracking stock of ${ITEM}`)).first()).toBeVisible()
  } finally {
    await signIn(owner, OWNER)
    await owner.goto('/staff/inventory')
    await owner.getByRole('button', { name: `Stock settings for ${ITEM}` }).first().click()
    const settings = owner.getByRole('dialog')
    await settings.getByRole('button', { name: 'Stop tracking' }).click()
    await settings.getByRole('button', { name: `Stop tracking ${ITEM}` }).click()
    await expect(owner.getByText(`Stopped tracking ${ITEM}`)).toBeVisible()
  }
})

test('expenses feed profit & loss, and the statement adds up', async ({ page }) => {
  const note = `E2E gas ${Date.now() % 100000}`
  await signIn(page, OWNER)
  await page.goto('/staff/expenses')
  await page.getByRole('button', { name: 'This month' }).click()
  await page.getByRole('button', { name: 'Add expense' }).first().click()
  const form = page.getByRole('dialog')
  await form.getByLabel('Amount (₹)').fill('1234')
  await form.getByLabel('Category').selectOption({ label: 'Gas & fuel' })
  await form.getByLabel('Note (optional)').fill(note)
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Gas & fuel · ₹1,234 saved')).toBeVisible()
  await expect(page.getByText(note).filter({ visible: true }).first()).toBeVisible()

  try {
    await page.goto('/staff/profit')
    await page.getByRole('button', { name: 'This month' }).click()
    const statement = page.getByRole('region', { name: 'Profit and loss statement' })
    await expect(statement.getByRole('row', { name: /^Gas & fuel/ })).toBeVisible()
    expect(await rowAmount(page, 'Gas & fuel')).toBeLessThanOrEqual(-1234)

    // Sales − food cost = gross; gross − operating − waste = net.
    const sales = await rowAmount(page, 'Sales')
    const food = await rowAmount(page, 'Food cost')
    const gross = await rowAmount(page, 'Gross profit')
    const opex = await rowAmount(page, 'Total operating expenses')
    const waste = await rowAmount(page, 'Waste')
    const net = await rowAmount(page, 'Net profit')
    expect(sales + food).toBe(gross)
    expect(gross + opex + waste).toBe(net)

    // Switching the food-cost method never counts ingredients twice.
    await page.getByLabel(/Ingredient purchases/).check()
    await expect(statement.getByRole('row', { name: /^Waste/ })).toHaveCount(0)
    const gross2 = await rowAmount(page, 'Gross profit')
    const net2 = await rowAmount(page, 'Net profit')
    expect(gross2 + (await rowAmount(page, 'Total operating expenses'))).toBe(net2)
    await page.getByLabel(/Item costs/).check()
  } finally {
    await page.goto('/staff/expenses')
    await page.getByRole('button', { name: 'This month' }).click()
    await page.getByRole('button', { name: /^Delete Gas & fuel ₹1,234/ }).first().click()
    await page.getByRole('dialog').getByRole('button', { name: /Delete ₹1,234/ }).click()
    await expect(page.getByText('Expense deleted')).toBeVisible()
  }
})

test('owner changes their own password, which needs the current one', async ({ page }) => {
  const temp = 'Temp.E2E.Pass.2026'
  await signIn(page, OWNER)
  await page.goto('/staff/settings')
  const form = page.getByRole('region', { name: 'Your login' })
  await form.getByLabel('Current password').fill('definitely-wrong')
  await form.getByLabel('New password', { exact: true }).fill(temp)
  await form.getByLabel('New password again').fill(temp)
  await form.getByRole('button', { name: 'Change password' }).click()
  await expect(form.getByText('Your current password is incorrect.')).toBeVisible()

  await form.getByLabel('Current password').fill(OWNER.password)
  await form.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByText('Password changed')).toBeVisible()
  try {
    await signIn(page, { email: OWNER.email, password: temp })
  } finally {
    // Put the original password back for the other tests.
    await page.goto('/staff/settings')
    const f = page.getByRole('region', { name: 'Your login' })
    await f.getByLabel('Current password').fill(temp)
    await f.getByLabel('New password', { exact: true }).fill(OWNER.password)
    await f.getByLabel('New password again').fill(OWNER.password)
    await f.getByRole('button', { name: 'Change password' }).click()
    await expect(page.getByText('Password changed')).toBeVisible()
  }
})

test('owner opens and closes the café from the header in one place', async ({ page }) => {
  await signIn(page, OWNER)
  await page.getByRole('button', { name: /Café is open/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close café' }).click()
  await expect(page.getByText('Closed — orders paused')).toBeVisible()
  await page.getByRole('button', { name: /Café is closed/ }).click()
  await expect(page.getByText('Open — taking orders')).toBeVisible()
  await expect(page.getByRole('button', { name: /Café is open/ })).toBeVisible()
})
