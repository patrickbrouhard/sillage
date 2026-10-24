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
  await select.fill('sQL')
  await select.press('ArrowDown')
  await select.press('Enter')
  await expect(page).toHaveURL('/?other=kept&tag_id=7')
  await expect(panel).toBeVisible()
  await expect(trigger.locator('.filter-count')).toHaveText('1')
  await page.getByRole('button', { name: 'Réinitialiser' }).click()
  await expect(page).toHaveURL('/?other=kept')
  await expect(select).toBeFocused()
  await expect(panel).toBeVisible()
  await trigger.click()
  await expect(panel).not.toBeVisible()
  await page.goBack()
  await expect(page.locator('.active-filter')).toContainText('SQLite')
  await page.reload()
  await expect(page.locator('.active-filter')).toContainText('SQLite')
  await page.getByRole('button', { name: /Retirer le filtre de tag/ }).click()
  await expect(trigger).toBeFocused()
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
      // Le retrait reste dans la pilule et centré sur le nom, même sur plusieurs lignes.
      const chip = page.locator('.active-filter')
      const chipBox = await chip.boundingBox()
      const labelBox = await chip.locator(':scope > span').boundingBox()
      const removeBox = await chip.getByRole('button').boundingBox()
      expect(removeBox!.x).toBeGreaterThanOrEqual(labelBox!.x + labelBox!.width - 1)
      expect(removeBox!.x + removeBox!.width).toBeLessThanOrEqual(chipBox!.x + chipBox!.width)
      expect(Math.abs(removeBox!.y + removeBox!.height / 2 - labelBox!.y - labelBox!.height / 2)).toBeLessThan(1)

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
    await page.route('**/api/v1/tags', route => route.fulfill({ json: { tags: [{ id: 7, name: 'SQLite' }, { id: 8, name: 'Architecture' }] } }))
    await page.goto('/?tag_id=7')
    const remove = page.getByRole('button', { name: 'Retirer le filtre de tag : SQLite', exact: true })
    await remove.hover()
    const target = await remove.boundingBox()
    expect(target!.width).toBe(40)
    expect(target!.height).toBe(40)
    expect(await remove.evaluate(button => getComputedStyle(button).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    const hover = await remove.locator('span').boundingBox()
    expect(hover!.width).toBe(24)
    expect(hover!.height).toBe(24)
    const cross = await remove.locator('svg').boundingBox()
    expect(cross!.x + cross!.width / 2).toBe(hover!.x + hover!.width / 2)
    expect(cross!.y + cross!.height / 2).toBe(hover!.y + hover!.height / 2)
    await page.locator('.library-summary').screenshot({ path: 'test-results/library-' + theme + '-remove-hover.png' })
    await page.getByRole('button', { name: /^Filtres/ }).click()
    await page.getByRole('combobox', { name: 'Filtrer par tag' }).fill('sql')
    await page.screenshot({ path: 'test-results/library-' + theme + '-suggestions-mobile.png' })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.screenshot({ path: 'test-results/library-' + theme + '-suggestions-desktop.png' })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.locator('.video-card').first().getByRole('link', { name: 'SQLite', exact: true }).focus()
    await page.screenshot({ path: 'test-results/library-' + theme + '-tag-focus.png' })
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

test('autocomplétion de filtrage : catalogue long, recherche locale, clavier et aucune création', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 500 })
  const tags = Array.from({ length: 60 }, (_, index) => ({ id: index + 1, name: 'Tag ' + String(index + 1).padStart(2, '0') }))
  tags.push({ id: 70, name: 'Agents IA' }, { id: 71, name: 'Architecture agents' })
  await page.route('**/api/v1/tags', route => route.fulfill({ json: { tags } }))
  let reads = 0
  let writes = 0
  page.on('request', request => { if (request.method() !== 'GET') writes++ })
  await page.route('**/api/v1/videos*', route => {
    reads++
    return route.fulfill({ json: { videos: [] } })
  })
  await page.goto('/?tag_id=999&other=kept')
  await expect(page.getByRole('status')).toHaveText('0 vidéo')
  const trigger = page.getByRole('button', { name: /^Filtres/ })
  const input = page.getByRole('combobox', { name: 'Filtrer par tag' })
  await trigger.click()
  await expect(input).toBeFocused()
  await expect(page.getByRole('option')).toHaveCount(62)
  await input.press('ArrowUp')
  const last = page.getByRole('option', { name: 'Tag 60', exact: true })
  await expect(last).toHaveAttribute('aria-selected', 'true')
  await expect(last).toBeInViewport()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await input.fill('aGeNt')
  await expect(page.getByRole('option')).toHaveCount(2)
  await input.press('ArrowDown')
  await input.press('ArrowDown')
  await input.press('ArrowUp')
  await expect(page.getByRole('option', { name: 'Agents IA', exact: true })).toHaveAttribute('aria-selected', 'true')
  expect(reads).toBe(1)
  await input.press('Enter')
  await expect(page).toHaveURL('/?tag_id=70&other=kept')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('')
  await expect(page.locator('.active-filter')).toContainText('Agents IA')
  await input.fill('Tag totalement absent')
  await input.press('Enter')
  await expect(page.getByText('Aucun tag correspondant.')).toBeVisible()
  await expect(page).toHaveURL('/?tag_id=70&other=kept')
  await expect(page.getByRole('option')).toHaveCount(0)
  expect(writes).toBe(0)
  await input.press('Escape')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect(trigger).toBeFocused()
})

for (const width of [375, 1440]) {
  test('liens indépendants de carte et de tags, souris, clavier et nouvel onglet à ' + width + ' px', async ({ page, context }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.route(/\/api\/v1\/videos(\?.*)?$/, route => route.fulfill({ json: { videos: [{
      id: 42, created_at: '2026-10-10T12:00:00Z', person_ids: [],
      tags: [{ id: 7, name: 'Agents' }, { id: 8, name: 'SQLite' }],
      sources: [{ id: 1, provider: 'youtube', title: 'Vidéo de finition', publisher: null, duration_ms: 0, thumbnail_url: null }],
    }] } }))
    await page.goto('/?tag_id=8')
    const card = page.locator('.video-card')
    const detail = card.getByRole('link', { name: 'Consulter : Vidéo de finition' })
    const agents = card.getByRole('link', { name: 'Agents', exact: true })
    await expect(card.locator('a a')).toHaveCount(0)
    await expect(agents).toHaveAttribute('href', '/?tag_id=7')
    await detail.focus()
    await page.keyboard.press('Tab')
    await expect(agents).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL('/?tag_id=7')
    await page.goBack()
    await expect(page).toHaveURL('/?tag_id=8')
    await agents.click()
    await expect(page).toHaveURL('/?tag_id=7')
    const [tagTab] = await Promise.all([
      context.waitForEvent('page'),
      agents.click({ modifiers: ['ControlOrMeta'] }),
    ])
    await tagTab.waitForURL('**/?tag_id=7')
    await tagTab.close()
    await expect(page).toHaveURL('/?tag_id=7')
    const [detailTab] = await Promise.all([
      context.waitForEvent('page'),
      card.click({ position: { x: 20, y: 20 }, modifiers: ['ControlOrMeta'] }),
    ])
    await detailTab.waitForURL('**/videos/42')
    await detailTab.close()
    await expect(page).toHaveURL('/?tag_id=7')
    // Le publisher, comme la miniature et les marges, appartient à la surface native du lien.
    const publisher = await card.locator('.publisher').boundingBox()
    await page.mouse.click(publisher!.x + 5, publisher!.y + 5)
    await expect(page).toHaveURL('/videos/42')
  })
}
