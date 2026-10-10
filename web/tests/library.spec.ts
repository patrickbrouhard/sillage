import { expect, test } from '@playwright/test'

test('affiche la bibliothèque persistée par Go et SQLite après redémarrage', async ({ page, request }) => {
  const response = await request.get('/api/v1/videos')
  expect(response.ok()).toBeTruthy()
  const { videos } = await response.json()
  // Un autre parcours peut ajouter une vidéo en parallèle ; on vérifie notre fixture stable.
  const seed = videos.find((video: { sources: { external_id: string }[] }) => video.sources[0].external_id === 'sillage-test')
  expect(seed).toBeDefined()
  await page.goto('/')
  await expect(page.getByRole('heading', { name: seed.sources[0].title })).toBeVisible()
  await expect(page.getByText('Les ateliers du code')).toBeVisible()
  await expect(page.getByLabel('Tags').getByText('SQLite', { exact: true })).toBeVisible()
  await expect(page.getByText('2:05', { exact: true })).toBeVisible()
  await expect(page.getByText('Aucun aperçu disponible')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: seed.sources[0].title })).toBeVisible()
  await page.getByRole('button', { name: 'Actualiser' }).click()
  await expect(page.getByRole('status')).toHaveText(/^[1-9]\d* vidéos?$/)
})

test('présente une bibliothèque vide sans action inactive', async ({ page }) => {
  await page.route('**/api/v1/videos', (route) => route.fulfill({ json: { videos: [] } }))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Votre bibliothèque est encore vide' })).toBeVisible()
  await expect(page.getByRole('status')).toHaveText('0 vidéo')
})

test('garde un chargement explicite puis permet de reprendre après une erreur API', async ({ page }) => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/v1/videos', async (route) => {
    await gate
    await route.fulfill({ status: 500, json: { error: { code: 'internal_error' } } })
  })
  await page.goto('/')
  await expect(page.getByRole('status')).toHaveText('Chargement de la bibliothèque…')
  await expect(page.getByRole('button', { name: 'Actualiser' })).toBeDisabled()
  release()
  await expect(page.getByRole('alert')).toContainText('Impossible de charger')
  await page.unroute('**/api/v1/videos')
  await page.getByRole('button', { name: 'Réessayer' }).click()
  await expect(page.getByRole('heading', { name: 'Comprendre SQLite et ses transactions' })).toBeVisible()
})

test('explique une indisponibilité réseau', async ({ page }) => {
  await page.route('**/api/v1/videos', (route) => route.abort())
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('Le serveur est inaccessible')
})

test('respecte la première source, les champs nuls et une durée de zéro sur écran étroit', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.route('**/api/v1/videos', (route) => route.fulfill({
    json: { videos: [{
      id: 9, created_at: '2026-10-10T10:00:00Z', tags: [], person_ids: [],
      sources: [
        { id: 1, provider: 'youtube', title: 'Première source', publisher: { id: 4, name: null }, duration_ms: 0, thumbnail_url: null },
        { id: 2, provider: 'youtube', title: 'Deuxième source' },
      ],
    }] },
  }))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Première source' })).toBeVisible()
  await expect(page.getByText('Deuxième source')).toHaveCount(0)
  await expect(page.getByText('Compte de publication sans nom')).toBeVisible()
  await expect(page.getByText('0:00', { exact: true })).toBeVisible()
  await expect(page.getByText('Aucun tag', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
})

test('sépare navigation directe, erreurs API et assets manquants', async ({ page, request }) => {
  await page.goto('/page-inconnue')
  await expect(page.getByRole('heading', { name: 'Page introuvable' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Page introuvable' })).toBeVisible()
  await page.getByRole('link', { name: 'Revenir à la bibliothèque' }).click()
  await expect(page.getByRole('heading', { name: 'Bibliothèque', exact: true })).toBeVisible()
  for (const url of ['/api/v1/inconnue', '/assets/inconnu.js', '/data/sillage.db']) {
    const response = await request.get(url)
    expect(response.status()).toBe(404)
    expect(await response.text()).not.toContain('<html')
  }
})
