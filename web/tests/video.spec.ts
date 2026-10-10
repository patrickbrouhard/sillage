import { expect, test } from '@playwright/test'
import type { Video } from '../src/api'

const fixture: Video = {
  id: 42,
  created_at: '2026-10-10T12:00:00Z',
  person_ids: [],
  tags: [{ id: 1, name: 'Connaissances' }],
  sources: [{
    id: 17,
    provider: 'youtube',
    external_id: 'test',
    canonical_url: 'https://www.youtube.com/watch?v=test',
    title: 'Une fiche de test',
    description: 'Une description\navec deux lignes.',
    publisher: { id: 8, name: 'Un compte' },
    thumbnail_url: null,
    duration_ms: 0,
  }],
}

test('ajout et doublon via Go/SQLite, fiche directe et historique navigateur', async ({ page, request }, testInfo) => {
  const externalID = `sillage-new-${testInfo.retry}`
  const inputURL = `https://youtu.be/${externalID}`
  await page.goto('/')
  await page.getByRole('link', { name: 'Ajouter une vidéo', exact: true }).click()
  await page.getByLabel('URL YouTube').fill(inputURL)
  const created = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/videos') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Ajouter la vidéo' }).click()
  expect((await created).status()).toBe(201)
  await expect(page.getByRole('status')).toHaveText('Vidéo ajoutée à la bibliothèque.')
  await page.getByRole('link', { name: 'Ouvrir la fiche' }).click()
  const detailURL = page.url()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Une nouvelle vidéo pour apprendre')
  await expect(page.getByText('Une description conservée dans SQLite.')).toBeHidden()
  await page.locator('summary').click()
  await expect(page.getByText('Une description conservée dans SQLite.')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Une nouvelle vidéo pour apprendre')
  await page.getByRole('link', { name: /Revenir à la bibliothèque/ }).click()
  await expect(page.getByRole('link', { name: 'Consulter : Une nouvelle vidéo pour apprendre' })).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(detailURL)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Une nouvelle vidéo pour apprendre')
  await page.goForward()
  await expect(page.getByRole('heading', { name: 'Bibliothèque', exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Ajouter une vidéo', exact: true }).click()
  await page.getByLabel('URL YouTube').fill(inputURL)
  const duplicate = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/videos') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Ajouter la vidéo' }).click()
  expect((await duplicate).status()).toBe(200)
  await expect(page.getByRole('status')).toContainText('déjà présente')
  await page.getByRole('link', { name: 'Ouvrir la fiche' }).click()
  await expect(page).toHaveURL(detailURL)
  const { videos } = await (await request.get('/api/v1/videos')).json()
  expect(videos.filter((video: Video) => video.sources[0]?.external_id === externalID)).toHaveLength(1)
})

test('ouvre une carte au clavier puis sa fiche par URL directe', async ({ page }) => {
  await page.goto('/')
  const card = page.getByRole('link', { name: 'Consulter : Comprendre SQLite et ses transactions' })
  await card.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/videos\/1$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Comprendre SQLite et ses transactions')
  await expect(page.locator('main')).toBeFocused()
  await page.goto('/videos/1')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Comprendre SQLite et ses transactions')
})

test('distingue une vidéo absente et un identifiant invalide', async ({ page }) => {
  await page.goto('/videos/999999999')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Vidéo introuvable')
  await page.getByRole('link', { name: /Revenir à la bibliothèque/ }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bibliothèque')
  await page.goto('/videos/invalide')
  await expect(page.getByRole('alert')).toContainText('L’identifiant vidéo est invalide.')
})

test('affiche toutes les sources, les tags directs et le texte brut sur écran étroit', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.route('**/api/v1/videos/42', (route) => route.fulfill({
    json: {
      ...fixture,
      sources: [
        fixture.sources[0],
        {
          ...fixture.sources[0], id: 18, title: 'Autre provenance', provider: 'autre',
          description: '<script>contenu source</script>',
          duration_ms: null, publisher: { id: 9, name: null },
          canonical_url: 'javascript:alert(1)',
        },
      ],
    },
  }))
  await page.goto('/videos/42')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Une fiche de test')
  await expect(page.getByRole('region', { name: 'Source 1 · YouTube' })).toContainText('Un compte')
  const second = page.getByRole('region', { name: 'Source 2 · autre' })
  await expect(second).toContainText('Autre provenance')
  await expect(second).toContainText('Compte sans nom')
  await expect(second).toContainText('Inconnue')
  await expect(second.getByRole('link')).toHaveCount(0)
  await expect(second).toContainText('<script>contenu source</script>')
  await expect(page.getByLabel('Tags de la vidéo')).toHaveText('Connaissances')
  await expect(page.getByRole('link', { name: /Ouvrir la source/ })).toHaveAttribute('href', fixture.sources[0].canonical_url!)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
})

for (const [status, code, message] of [
  [400, 'bad_request', 'Vérifiez l’URL'],
  [502, 'metadata_fetch_failed', 'auprès de YouTube'],
  [504, 'metadata_fetch_timeout', 'délai d’acquisition'],
  [500, 'internal_error', 'Le serveur a rencontré une erreur'],
] as const) {
  test(`conserve la saisie et permet de réessayer après ${code}`, async ({ page }) => {
    let fail = true
    await page.route('**/api/v1/videos', (route) => route.fulfill(fail
      ? { status, json: { error: { code, message: 'Un message technique variable' } } }
      : { status: 201, json: fixture }))
    await page.goto('/videos/new')
    await page.getByLabel('URL YouTube').fill('https://youtu.be/test')
    await page.getByRole('button', { name: 'Ajouter la vidéo' }).click()
    await expect(page.getByRole('alert')).toContainText(message)
    await expect(page.getByRole('alert')).not.toContainText('technique variable')
    await expect(page.getByLabel('URL YouTube')).toHaveValue('https://youtu.be/test')
    fail = false
    await page.getByRole('button', { name: 'Ajouter la vidéo' }).click()
    await expect(page.getByRole('status')).toContainText('Vidéo ajoutée')
    await expect(page.getByRole('link', { name: 'Ouvrir la fiche' })).toHaveAttribute('href', '/videos/42')
  })
}

test('verrouille les soumissions pendant une acquisition lente sans relance automatique', async ({ page }) => {
  let calls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/v1/videos', async (route) => {
    calls++
    expect(route.request().postDataJSON()).toEqual({ url: 'https://youtu.be/test' })
    await gate
    await route.fulfill({ status: 201, json: fixture })
  })
  await page.goto('/videos/new')
  await page.getByLabel('URL YouTube').fill('https://youtu.be/test')
  await page.getByRole('button', { name: 'Ajouter la vidéo' }).click()
  await expect(page.getByRole('status')).toContainText('Récupération des métadonnées')
  await expect(page.getByLabel('URL YouTube')).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Acquisition en cours…' })).toBeDisabled()
  await page.locator('form').evaluate((form) => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  release()
  await expect(page.getByRole('status')).toContainText('Vidéo ajoutée')
  expect(calls).toBe(1)
})

test('une acquisition quittée ne réaffiche pas un ancien résultat', async ({ page }) => {
  let release: () => void = () => {}
  let completed: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const done = new Promise<void>((resolve) => { completed = resolve })
  await page.route('**/api/v1/videos', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    await gate
    await route.fulfill({ status: 201, json: fixture })
    completed()
  })
  await page.goto('/videos/new')
  await page.getByLabel('URL YouTube').fill('https://youtu.be/test')
  await page.getByRole('button', { name: 'Ajouter la vidéo' }).click()
  await expect(page.getByRole('status')).toContainText('Récupération')
  await page.getByRole('link', { name: /Revenir à la bibliothèque/ }).click()
  await page.getByRole('link', { name: 'Ajouter une vidéo', exact: true }).click()
  release()
  await done
  await expect(page.getByLabel('URL YouTube')).toHaveValue('')
  await expect(page.getByRole('link', { name: 'Ouvrir la fiche' })).toHaveCount(0)
})

test('une ancienne lecture ne remplace pas la fiche ouverte ensuite', async ({ page }) => {
  let release: () => void = () => {}
  let completed: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const done = new Promise<void>((resolve) => { completed = resolve })
  await page.route('**/api/v1/videos/42', async (route) => {
    await gate
    await route.fulfill({ json: fixture })
    completed()
  })
  await page.goto('/videos/42')
  await expect(page.getByRole('status')).toHaveText('Chargement de la vidéo…')
  await page.getByRole('link', { name: /Revenir à la bibliothèque/ }).click()
  await page.getByRole('link', { name: 'Consulter : Comprendre SQLite et ses transactions' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Comprendre SQLite et ses transactions')
  release()
  await done
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Comprendre SQLite et ses transactions')
})

test('une coupure réseau préserve l’URL sans prétendre que rien n’a été enregistré', async ({ page }) => {
  await page.route('**/api/v1/videos', (route) => route.abort())
  await page.goto('/videos/new')
  await page.getByLabel('URL YouTube').fill('https://youtu.be/test')
  await page.getByRole('button', { name: 'Ajouter la vidéo' }).click()
  await expect(page.getByRole('alert')).toContainText('peut-être été enregistrée')
  await expect(page.getByLabel('URL YouTube')).toHaveValue('https://youtu.be/test')
})

test('permet de relire une fiche après une erreur serveur', async ({ page }) => {
  let fail = true
  await page.route('**/api/v1/videos/42', (route) => route.fulfill(fail
    ? { status: 500, json: { error: { code: 'internal_error' } } }
    : { json: fixture }))
  await page.goto('/videos/42')
  await expect(page.getByRole('alert')).toContainText('Le serveur a rencontré une erreur')
  fail = false
  await page.getByRole('button', { name: 'Réessayer' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Une fiche de test')
  await expect(page).toHaveTitle('Une fiche de test · Sillage')
})
