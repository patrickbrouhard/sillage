import { test, expect } from '@playwright/test'

test('crée et révoque une clé sans exposer à nouveau son secret', async ({ page }) => {
 await page.goto('/settings/api-keys')
 await page.getByLabel('Nom de l’intégration').fill('Playwright')
 await page.getByLabel('Sans expiration').check()
 await page.getByRole('button', { name: 'Créer une clé', exact: true }).click()
 const secret = page.locator('code')
 await expect(secret).toContainText('sil_')
 const value = await secret.textContent()
 await page.getByRole('button', { name: 'Fermer le secret' }).click()
 await page.reload()
 await expect(page.getByText(value!, { exact: true })).toHaveCount(0)
 const row = page.locator('li').filter({ has: page.getByText('Playwright', { exact: true }) })
 page.once('dialog', dialog => dialog.accept())
 await row.getByRole('button', { name: 'Révoquer', exact: true }).click()
 await expect(row.getByText('Révoquée', { exact: true })).toBeVisible()
})


test('une réponse perdue ne recrée pas la clé et permet sa révocation', async ({ page }) => {
 await page.goto('/settings/api-keys')
 let creates = 0
 await page.route('**/api/v1/api-keys', async route => {
  if (route.request().method() !== 'POST') { await route.continue(); return }
  creates++
  await route.fetch()
  await route.abort('failed')
 })
 await page.getByLabel('Nom de l’intégration').fill('Réponse perdue')
 await page.getByLabel('Sans expiration').check()
 await page.getByRole('button', { name: 'Créer une clé', exact: true }).click()
 await expect(page.getByRole('alert')).toContainText('Résultat non confirmé')
 await page.getByRole('button', { name: 'Actualiser', exact: true }).click()
 await expect(page.getByText('Réponse perdue', { exact: true })).toBeVisible()
 expect(creates).toBe(1)
 await expect(page.locator('code')).toHaveCount(0)
})


test('écarte un secret reçu après verrouillage et reste lisible sur mobile', async ({ page }) => {
 await page.setViewportSize({ width: 375, height: 812 })
 await page.goto('/settings/api-keys')
 let release!: () => void
 let accepted!: () => void
 const saved = new Promise<void>(resolve => { accepted = resolve })
 const held = new Promise<void>(resolve => { release = resolve })
 await page.route('**/api/v1/api-keys', async route => {
  if (route.request().method() !== 'POST') { await route.continue(); return }
  const response = await route.fetch()
  accepted()
  await held
  await route.fulfill({ response })
 })
 await page.getByLabel('Nom de l’intégration').fill('Réponse tardive')
 await page.getByLabel('Sans expiration').check()
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
 await page.getByRole('button', { name: 'Créer une clé', exact: true }).click()
 await saved
 await page.route('**/api/v1/auth/session', route => route.fulfill({ json: { authenticated: false, methods: 'local', csrf_token: 'expired' } }))
 await page.evaluate(() => window.dispatchEvent(new Event('focus')))
 await expect(page.getByRole('heading', { name: 'Reconnectez-vous à Sillage' })).toBeVisible()
 release()
 await expect(page.locator('.api-keys-page form button')).toBeEnabled()
 await expect(page.locator('code')).toHaveCount(0)
})


for (const phase of ['visible', 'pending'] as const) {
 test(`une sonde de session inchangée conserve le secret ${phase}`, async ({ page }) => {
  await page.goto('/settings/api-keys')
  let release!: () => void
  let accepted!: () => void
  const saved = new Promise<void>(resolve => { accepted = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  if (phase === 'pending') await page.route('**/api/v1/api-keys', async route => {
   if (route.request().method() !== 'POST') { await route.continue(); return }
   const response = await route.fetch()
   accepted()
   await held
   await route.fulfill({ response })
  })
  await page.getByLabel('Nom de l’intégration').fill(`Sonde ${phase}`)
  await page.getByLabel('Sans expiration').check()
  await page.getByRole('button', { name: 'Créer une clé', exact: true }).click()
  if (phase === 'pending') await saved
  else await expect(page.locator('code')).toContainText('sil_')
  const probe = page.waitForResponse('**/api/v1/auth/session')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await (await probe).finished()
  // Attendre la publication React avant de libérer la réponse de création.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  if (phase === 'pending') release()
  await expect(page.locator('.api-keys-page form button')).toBeEnabled()
  await expect(page.locator('code')).toContainText('sil_')
  // Un autre cookie, même sans verrouillage intermédiaire, invalide le secret.
  await page.route('**/api/v1/auth/session', async route => {
   const response = await route.fetch()
   const body = await response.json()
   await route.fulfill({ json: { ...body, csrf_token: 'another-session' } })
  })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('code')).toHaveCount(0)
 })
}
