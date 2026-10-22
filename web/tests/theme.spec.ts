import { selectTheme } from './navigationHelpers'
import { expect, test } from './fixtures'

test('le caret natif suit les thèmes sans remonter l’éditeur ni perdre son historique', async ({ page, request }, info) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trcaret0001' } })).json()
  await page.goto(`/videos/${video.id}`)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  const node = await editor.elementHandle()
  await editor.click()
  await page.keyboard.type('Texte')
  for (const [theme, color, background] of [
    ['light', 'rgb(36, 52, 77)', 'rgb(255, 255, 255)'],
    ['dark', 'rgb(224, 232, 245)', 'rgb(16, 28, 48)'],
  ]) {
    await selectTheme(page, theme)
    await editor.focus()
    // L'éditeur utilise le caret natif : sa couleur effective doit contraster avec le fond.
    await expect(editor).toHaveCSS('caret-color', color)
    await expect(editor.locator('.cm-line').first()).toHaveCSS('caret-color', color)
    await expect(page.locator('.markdown-editor')).toHaveCSS('background-color', background)
    expect(await node!.evaluate(element => element === document.querySelector('.cm-content'))).toBe(true)
    await editor.screenshot({ path: info.outputPath(`caret-${theme}.png`), caret: 'initial' })
  }
  await page.keyboard.press('Control+z')
  await expect(editor).toHaveText('')
  await page.keyboard.press('Control+Shift+Z')
  await expect(editor).toHaveText('Texte')
  await page.keyboard.press('Shift+Home')
  await selectTheme(page, 'system')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(editor).toHaveCSS('caret-color', 'rgb(36, 52, 77)')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(editor).toHaveCSS('caret-color', 'rgb(224, 232, 245)')
  await editor.focus()
  await page.keyboard.type('Remplacement')
  await expect(editor).toHaveText('Remplacement')
  await page.keyboard.press('Control+s')
  await expect.poll(async () => (await (await request.get(`/api/v1/videos/${video.id}/note`)).json()).content_md).toBe('Remplacement')
})

test('suit le système et mémorise les choix explicites sans dépendre du système', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  const theme = page.getByLabel('Thème', { exact: true })
  await expect(theme).toHaveValue('system')
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(16, 24, 39)')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(242, 245, 250)')
  await selectTheme(page, 'dark')
  await page.reload()
  await expect(theme).toHaveValue('dark')
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(16, 24, 39)')
  await selectTheme(page, 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(242, 245, 250)')
  await selectTheme(page, 'system')
  await page.reload()
  await expect(theme).toHaveValue('system')
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(16, 24, 39)')
  await page.setViewportSize({ width: 320, height: 800 })
  await page.getByRole('button', { name: 'Ouvrir la navigation' }).click()
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
  await selectTheme(page, 'dark')
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(16, 24, 39)')
})

test('ignore une préférence locale inconnue', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sillage.theme', 'invalid'))
  await page.goto('/')
  await expect(page.getByLabel('Thème', { exact: true })).toHaveValue('system')
})
