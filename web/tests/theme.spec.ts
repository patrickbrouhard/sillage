import { expect, test } from './fixtures'

test('suit le système et mémorise les choix explicites sans dépendre du système', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  const theme = page.getByLabel('Thème', { exact: true })
  await expect(theme).toHaveValue('system')
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(16, 24, 39)')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(242, 245, 250)')
  await theme.selectOption('dark')
  await page.reload()
  await expect(theme).toHaveValue('dark')
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(16, 24, 39)')
  await theme.selectOption('light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(242, 245, 250)')
  await theme.selectOption('system')
  await page.reload()
  await expect(theme).toHaveValue('system')
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(16, 24, 39)')
  await page.setViewportSize({ width: 320, height: 800 })
  await expect(theme).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('reste utilisable lorsque le stockage local est interdit', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError') } })
  })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  await expect(page.getByLabel('Thème', { exact: true })).toHaveValue('system')
  await page.getByLabel('Thème', { exact: true }).selectOption('dark')
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(16, 24, 39)')
})

test('ignore une préférence locale inconnue', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sillage.theme', 'invalid'))
  await page.goto('/')
  await expect(page.getByLabel('Thème', { exact: true })).toHaveValue('system')
})
