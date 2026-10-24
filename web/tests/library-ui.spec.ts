import { expect, test } from './fixtures'

test('le panneau natif conserve le filtre immédiat, le focus et les paramètres voisins', async ({ page }) => {
  let calls = 0
  await page.route('**/api/v1/tags', route => route.fulfill({ json: { tags: [{ id: 7, name: 'SQLite' }] } }))
  await page.route('**/api/v1/videos*', route => {
    calls++
    return route.fulfill({ json: { videos: [] } })
  })
  await page.goto('/?other=kept')
  await expect(page.getByRole('status')).toHaveText('0 vidéo')
  const trigger = page.getByRole('button', { name: /^Filtres/ })
  const select = page.getByLabel('Filtrer par tag')
  const panel = page.getByRole('region', { name: 'Filtrage de la bibliothèque' })
  await expect(trigger).toHaveText('Filtres')
  await trigger.click()
  await expect(select).toBeFocused()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await select.press('Space')
  await select.press('Escape')
  await expect(panel).toBeVisible()
  await select.press('Escape')
  await expect(panel).not.toBeVisible()
  await expect(trigger).toBeFocused()
  expect(calls).toBe(1)
  await trigger.click()
  await expect(select).toBeFocused()
  await select.press('Tab')
  await expect(page.getByRole('link', { name: 'Ajouter une vidéo', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await trigger.click()
  await select.selectOption('7')
  await expect(page).toHaveURL('/?other=kept&tag_id=7')
  await expect(panel).toBeVisible()
  await expect(trigger.locator('.filter-count')).toHaveText('1')
  await page.getByRole('button', { name: 'Réinitialiser' }).click()
  await expect(page).toHaveURL('/?other=kept')
  await expect(panel).toBeVisible()
  await trigger.click()
  await expect(panel).not.toBeVisible()
  await page.goBack()
  await expect(page.locator('.active-filter')).toContainText('SQLite')
  await page.reload()
  await expect(page.locator('.active-filter')).toContainText('SQLite')
  await page.getByRole('button', { name: /Retirer le filtre de tag/ }).click()
  await expect(page).toHaveURL('/?other=kept')
  await trigger.click()
  await page.getByRole('searchbox').click()
  await expect(panel).not.toBeVisible()
  await expect(page.getByRole('searchbox')).toBeFocused()
  await trigger.click()
  await page.getByRole('button', { name: 'Ouvrir la navigation' }).click()
  await expect(panel).not.toBeVisible()
  await expect(page.getByRole('dialog')).toBeVisible()
})

test('le retrait reste disponible sans compteur ni catalogue et compte un seul critère', async ({ page }) => {
  await page.route('**/api/v1/tags', route => route.fulfill({ status: 500, json: { error: { code: 'internal_error' } } }))
  await page.goto('/?tag_id=7&tag_id=8&other=kept')
  await expect(page.getByRole('alert')).toContainText('Un seul filtre')
  await expect(page.locator('.filter-count')).toHaveText('1')
  await page.getByRole('button', { name: /^Filtres/ }).click()
  await expect(page.getByRole('region')).toContainText('indépendante du catalogue')
  await page.getByRole('button', { name: /^Filtres/ }).click()
  await page.getByRole('button', { name: /Retirer le filtre de tag/ }).click()
  await expect(page).toHaveURL('/?other=kept')
  await page.goto('/?tag_id=999999999')
  await expect(page.locator('.active-filter')).toContainText('999999999')
  await page.getByRole('searchbox').fill('SQLite')
  await page.getByRole('searchbox').press('Enter')
  await expect(page).toHaveURL('/search?q=SQLite')
  await expect(page.locator('.provider-badge')).toHaveCount(0)
})

for (const theme of ['light', 'dark'] as const) {
  test('composition compacte et sans débordement en thème ' + theme, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.route('**/api/v1/tags', route => route.fulfill({ json: { tags: [{ id: 7, name: 'Tag très long '.repeat(15) }] } }))
    await page.route('**/api/v1/videos*', route => route.fulfill({ json: { videos: [{
      id: 42, created_at: '2026-10-10T12:00:00Z', person_ids: [],
      tags: Array.from({ length: 12 }, (_, id) => ({ id, name: 'Tag très long '.repeat(8) })),
      sources: [{ id: 1, provider: 'youtube', title: 'Titre intégral '.repeat(20), publisher: null, duration_ms: 0, thumbnail_url: null }],
    }] } }))
    await page.goto('/?tag_id=7')
    await expect(page.locator('.video-card')).toHaveCount(1)
    for (const width of [320, 359, 360, 375, 599, 600, 601, 768, 1024, 1199, 1200, 1201, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
      const search = await page.getByRole('search').boundingBox()
      const header = await page.locator('.site-header').boundingBox()
      const actions = await page.locator('.library-header-actions').boundingBox()
      expect(Math.abs(search!.x + search!.width / 2 - header!.width / 2)).toBeLessThan(1)
      if (width >= 1200) {
        expect(header!.height).toBe(56)
        expect(search!.x + search!.width).toBeLessThanOrEqual(actions!.x)
      } else expect(search!.y).toBeGreaterThanOrEqual(actions!.y + actions!.height)
      await page.getByRole('button', { name: /^Filtres/ }).click()
      const panel = await page.locator('.library-filter').boundingBox()
      expect(panel!.x).toBeGreaterThanOrEqual(0)
      expect(panel!.x + panel!.width).toBeLessThanOrEqual(width)
      await page.keyboard.press('Escape')
    }
    // Le zoom desktop 200 % divise le viewport CSS par deux ; la taille du texte est aussi éprouvée.
    await page.setViewportSize({ width: 720, height: 450 })
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    await page.evaluate(() => { document.documentElement.style.fontSize = '' })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.screenshot({ path: 'test-results/library-' + theme + '-desktop.png', fullPage: true })
    await page.setViewportSize({ width: 320, height: 240 })
    await page.getByRole('button', { name: /^Filtres/ }).click()
    const shortPanel = await page.locator('.library-filter').boundingBox()
    expect(shortPanel!.y + shortPanel!.height).toBeLessThanOrEqual(240)
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 320, height: 800 })
    await page.getByRole('button', { name: /^Filtres/ }).click()
    await page.screenshot({ path: 'test-results/library-' + theme + '-mobile.png' })
    await page.route('https://images.example.test/thumbnail.svg', route => route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#fff"/><path d="M0 360L320 0L640 360Z" fill="#294b7d"/></svg>',
    }))
    await page.route('**/api/v1/videos*', route => route.fulfill({ json: { videos: Array.from({ length: 4 }, (_, id) => ({
      id, created_at: '2026-10-10T12:00:00Z', person_ids: [],
      tags: id === 3 ? [] : [{ id: 7, name: 'SQLite' }, { id: 8, name: 'Architecture' }],
      sources: [{ id, provider: 'youtube', title: ['Comprendre SQLite et ses transactions', 'Concevoir une application durable', 'Du code aux connaissances', 'Une vidéo sans tag'][id], publisher: { id: 1, name: 'Les ateliers du code' }, duration_ms: 125000, thumbnail_url: id % 2 ? null : 'https://images.example.test/thumbnail.svg' }],
    })) } }))
    await page.goto('/')
    await expect(page.locator('.video-card')).toHaveCount(4)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.locator('.video-card img').first().evaluate(image => (image as HTMLImageElement).decode())
    await page.screenshot({ path: 'test-results/library-' + theme + '-usual.png' })
    await page.setViewportSize({ width: 375, height: 812 })
    await page.screenshot({ path: 'test-results/library-' + theme + '-usual-mobile.png' })
  })
}

test('le footer est absent sur toutes les coques', async ({ page }) => {
  for (const path of ['/', '/search', '/videos/new', '/page-inconnue']) {
    await page.goto(path)
    await expect(page.locator('footer')).toHaveCount(0)
    await expect(page.getByText('Des vidéos aux idées.')).toHaveCount(0)
  }
})

test('le filtre se retire pendant une réponse retardée sans attendre le compteur', async ({ page }) => {
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/v1/videos?tag_id=7', async route => {
    await gate
    await route.fulfill({ json: { videos: [] } })
  })
  await page.goto('/?tag_id=7&other=kept')
  await expect(page.getByRole('status')).toContainText('Chargement')
  await page.getByRole('button', { name: /Retirer le filtre de tag/ }).click()
  await expect(page).toHaveURL('/?other=kept')
  release()
  await expect(page.locator('.video-card').first()).toBeVisible()
  await expect(page.locator('.active-filter')).toHaveCount(0)
})
