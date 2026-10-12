import { expect, test } from './fixtures'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/videos/42', route => route.fulfill({ json: {
    id: 42, created_at: '2026-10-12', tags: [], person_ids: [],
    sources: [{ id: 17, provider: 'youtube', external_id: 'abcdefghijk', title: 'Vidéo test',
      canonical_url: 'https://www.youtube.com/watch?v=abcdefghijk' }],
  } }))
  await page.route('**/note', route => route.fulfill({ status: 404, json: { error: { code: 'note_not_found' } } }))
  await page.route('**/transcript', route => route.fulfill({ json: {
    language: 'fr', provenance: 'youtube_auto', last_fetched_at: '2026-10-12T10:00:00Z',
    items: [{ start_ms: 1000, text: 'Transcription indépendante' }],
  } }))
})

test('pause avant masquage, position et instance conservées sans reprise', async ({ page }) => {
  await page.goto('/videos/42')
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await page.evaluate(() => {
    const player = window.youtubeTest.players.at(-1)!
    player.position = 42.75
    player.emitState(1)
  })
  await page.getByRole('button', { name: 'Masquer le lecteur' }).click()
  await expect(page.locator('.youtube-frame iframe')).toBeHidden()
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.state)).toBe(2)
  await expect(page.getByText('Transcription indépendante')).toBeVisible()
  await page.getByRole('button', { name: 'Afficher le lecteur' }).click()
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  expect(await page.evaluate(() => window.youtubeTest.players.map(player => ({
    state: player.state, position: player.position, destroyed: player.destroyed,
  })))).toEqual([{ state: 2, position: 42.75, destroyed: false }])
  await page.getByRole('link', { name: 'Revenir à la bibliothèque' }).click()
  await expect(page).toHaveURL('/')
  await expect.poll(() => page.evaluate(() => window.youtubeTest.players.every(player => player.destroyed))).toBe(true)
})

test('une pause non confirmée détruit le lecteur avant de le masquer', async ({ page }) => {
  await page.goto('/videos/42')
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  await page.evaluate(() => {
    window.youtubeTest.confirmPause = false
    window.youtubeTest.players.at(-1)!.emitState(1)
  })
  await page.getByRole('button', { name: 'Masquer le lecteur' }).click()
  await expect(page.getByRole('button', { name: 'Afficher le lecteur' })).toBeVisible()
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.destroyed)).toBe(true)
  await page.getByRole('button', { name: 'Afficher le lecteur' }).click()
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.state)).toBe(-1)
})

for (const [code, message] of [[100, 'indisponible ou privée'], [101, 'n’autorise pas'], [153, 'identifier cette intégration']] as const) {
  test(`erreur YouTube ${code} isolée et réessai`, async ({ page }) => {
    await page.goto('/videos/42')
    await expect(page.locator('.youtube-frame iframe')).toBeVisible()
    await page.evaluate(code => window.youtubeTest.players.at(-1)!.options.events.onError({ data: code }), code)
    await expect(page.getByRole('alert')).toContainText(message)
    await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toBeVisible()
    await expect(page.getByText('Transcription indépendante')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Ouvrir sur YouTube' })).toBeVisible()
    await page.getByRole('button', { name: 'Réessayer le lecteur' }).click()
    await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  })
}

test('API bloquée puis nouvel essai sans toucher aux autres panneaux', async ({ page }) => {
  await page.route('https://www.youtube.com/iframe_api', route => route.abort())
  await page.goto('/videos/42')
  await expect(page.getByRole('alert')).toContainText('Impossible de charger l’API YouTube')
  await expect(page.getByText('Transcription indépendante')).toBeVisible()
  await page.unroute('https://www.youtube.com/iframe_api')
  await page.getByRole('button', { name: 'Réessayer le lecteur' }).click()
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
})

test('masquage avant onReady et événements tardifs ne réactivent pas un lecteur détruit', async ({ page }) => {
  await page.addInitScript(() => { window.youtubeTest = { players: [], autoReady: false, confirmPause: true } })
  await page.goto('/videos/42')
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await page.getByRole('button', { name: 'Masquer le lecteur' }).click()
  await expect(page.locator('.youtube-frame iframe')).toHaveCount(0)
  await page.evaluate(() => {
    const old = window.youtubeTest.players[0]
    old.options.events.onReady({ target: old })
    old.options.events.onError({ data: 100 })
    window.youtubeTest.autoReady = true
  })
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', { name: 'Afficher le lecteur' }).click()
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  expect(await page.evaluate(() => window.youtubeTest.players.map(player => player.destroyed))).toEqual([true, false])
})

test('initialisation sans onReady bornée, événements tardifs ignorés puis reprise', async ({ page }) => {
  await page.addInitScript(() => { window.youtubeTest = { players: [], autoReady: false, confirmPause: true } })
  await page.clock.install()
  await page.goto('/videos/42')
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await page.clock.runFor(15_100)
  await expect(page.getByRole('alert')).toContainText('ne répond pas')
  await page.evaluate(() => {
    const old = window.youtubeTest.players[0]
    old.options.events.onReady({ target: old })
    window.youtubeTest.autoReady = true
  })
  await expect(page.getByRole('alert')).toContainText('ne répond pas')
  await page.getByRole('button', { name: 'Réessayer le lecteur' }).click()
  await page.clock.runFor(100)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
})

test('chargement du script sans callback borné et indépendant de la note', async ({ page }) => {
  await page.route('https://www.youtube.com/iframe_api', route => route.fulfill({ contentType: 'application/javascript', body: '' }))
  await page.clock.install()
  await page.goto('/videos/42')
  await expect(page.getByText('Chargement du lecteur YouTube…')).toBeVisible()
  // Ne pas faire expirer artificiellement le GET de note encore en transit.
  await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toBeVisible()
  await page.clock.runFor(15_100)
  await expect(page.getByRole('alert')).toContainText('trop long')
  await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toBeVisible()
  await expect(page.getByText('Transcription indépendante')).toBeVisible()
})
