import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { Tag, Video } from '../src/api'

const fixture: Video = {
  id: 42, created_at: '2026-10-10T12:00:00Z', person_ids: [],
  tags: [{ id: 3, name: 'Déjà associé' }],
  sources: [{
    id: 1, provider: 'youtube', external_id: 'test', canonical_url: null,
    title: 'Vidéo de classement', description: 'Première ligne\nSeconde ligne',
    thumbnail_url: null, duration_ms: null, publisher: null,
  }],
}

/** Ouvre l'éditeur après sa relecture initiale des associations. */
async function openEditor(page: Page) {
  await page.getByRole('button', { name: /^(Gérer les tags|Ajouter des tags)$/ }).click()
  await expect(page.getByRole('combobox', { name: 'Rechercher ou ajouter un tag' })).toBeEnabled()
}

/** Isole les erreurs et délais de transport sans remplacer le parcours Go/SQLite. */
async function mockDetail(page: Page) {
  await page.route('**/api/v1/videos/42', (route) => route.fulfill({ json: fixture }))
  await page.route('**/api/v1/tags', (route) => route.fulfill({
    json: { tags: [...fixture.tags, { id: 4, name: 'Programmation' }, { id: 5, name: 'Programmes' }] },
  }))
}

test('classe deux vidéos via Go/SQLite et conserve les associations partagées', async ({ page, request }, info) => {
  const ids: number[] = []
  for (const suffix of ['a', 'b']) {
    const response = await request.post('/api/v1/videos', { data: { url: `https://youtu.be/sillage-tags-${info.retry}-${suffix}` } })
    expect(response.status()).toBe(201)
    ids.push((await response.json()).id)
  }
  const name = `Classement Straße ${info.retry}`
  await page.goto(`/videos/${ids[0]}`)
  await openEditor(page)
  const input = page.getByRole('combobox', { name: 'Rechercher ou ajouter un tag' })
  await input.fill(name)
  await page.getByRole('option', { name: `Ajouter « ${name} »`, exact: true }).click()
  await expect(input).toHaveValue('')
  await expect(input).toBeFocused()
  // La réutilisation insensible à la casse est vérifiée par le serveur réel.
  await input.fill(name.toUpperCase())
  await input.press('Enter')
  await expect(input).toHaveValue('')
  await expect(page.getByLabel('Associations de tags').locator('li')).toHaveCount(1)
  await page.getByRole('button', { name: 'Fermer', exact: true }).click()
  const tagLink = page.getByRole('link', { name, exact: true })
  const filterURL = await tagLink.getAttribute('href')
  expect(filterURL).toMatch(/^\/\?tag_id=\d+$/)
  await tagLink.click()
  await expect(page).toHaveURL(filterURL!)
  await expect(page.locator('.video-card')).toHaveCount(1)

  await page.goto(`/videos/${ids[1]}`)
  await openEditor(page)
  await input.fill('Classement Straße')
  await input.press('ArrowDown')
  await expect(page.getByRole('option', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
  await input.press('Enter')
  await expect(input).toHaveValue('')
  await page.getByRole('button', { name: 'Fermer', exact: true }).click()
  await page.getByRole('link', { name, exact: true }).click()
  await expect(page.locator('.video-card')).toHaveCount(2)
  await page.reload()
  await expect(page.getByLabel('Filtrer par tag')).toHaveValue(filterURL!.split('=')[1])
  await page.getByRole('link', { name: `Consulter : sillage-tags-${info.retry}-a` }).click()
  await page.reload()
  await page.getByRole('link', { name: /Revenir à la bibliothèque/ }).click()
  await expect(page).toHaveURL(filterURL!)
  await page.goBack()
  await expect(page).toHaveURL(`/videos/${ids[0]}`)
  await openEditor(page)
  await page.getByRole('button', { name: `Retirer le tag ${name} de cette vidéo` }).click()
  await expect(page.getByRole('status')).toContainText('Tag retiré')
  await page.getByRole('button', { name: 'Fermer', exact: true }).click()
  await page.getByRole('link', { name: /Revenir à la bibliothèque/ }).click()
  await expect(page.locator('.video-card')).toHaveCount(1)
  await expect(page.getByRole('link', { name: `Consulter : sillage-tags-${info.retry}-b` })).toBeVisible()
  await page.getByRole('button', { name: 'Retirer le filtre' }).click()
  await expect(page).toHaveURL('/')
  await page.goBack()
  await expect(page).toHaveURL(filterURL!)
  await page.goForward()
  await expect(page).toHaveURL('/')

  const first: Video = await (await request.get(`/api/v1/videos/${ids[0]}`)).json()
  const second: Video = await (await request.get(`/api/v1/videos/${ids[1]}`)).json()
  expect(first.tags).toEqual([])
  expect(second.tags.map((tag) => tag.name)).toEqual([name])
  await request.delete(`/api/v1/videos/${ids[1]}/tags/${second.tags[0].id}`)
  await page.goto(filterURL!)
  await expect(page.getByRole('heading', { name: 'Aucune vidéo pour ce tag' })).toBeVisible()
  await expect(page.getByLabel('Filtrer par tag').locator('option:checked')).toHaveText(name)
  const catalog: { tags: Tag[] } = await (await request.get('/api/v1/tags')).json()
  expect(catalog.tags).toContainEqual(second.tags[0])
})

test('autocomplétion clavier, Échap et fermeture native préservent le focus', async ({ page }) => {
  await mockDetail(page)
  let submitted = ''
  await page.route('**/api/v1/videos/42/tags', async (route) => {
    submitted = route.request().postDataJSON().names[0]
    await route.fulfill({ json: { tags: [...fixture.tags, { id: 4, name: 'Programmation' }] } })
  })
  await page.goto('/videos/42')
  await openEditor(page)
  const input = page.getByRole('combobox', { name: 'Rechercher ou ajouter un tag' })
  await expect(input).toBeFocused()
  await input.fill('progra')
  await input.press('ArrowDown')
  await expect(page.getByRole('option', { name: 'Programmation', exact: true })).toHaveAttribute('aria-selected', 'true')
  await input.press('ArrowDown')
  await expect(page.getByRole('option', { name: 'Programmes', exact: true })).toHaveAttribute('aria-selected', 'true')
  await input.press('ArrowUp')
  await input.press('Enter')
  await expect(input).toHaveValue('')
  expect(submitted).toBe('Programmation')
  await input.fill('Programmation')
  await expect(page.getByRole('option', { name: 'Programmation', exact: true })).toHaveCount(0)
  await expect(page.getByText('Ce tag est déjà associé.')).toBeVisible()
  await input.fill('rust')
  await input.press('Escape')
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(input).toHaveAttribute('aria-expanded', 'false')
  await expect(input).toHaveValue('rust')
  await input.press('Escape')
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Gérer les tags', exact: true })).toBeFocused()
})

test('catalogue indisponible et validation conservent la saisie et les associations', async ({ page }) => {
  await mockDetail(page)
  await page.route('**/api/v1/tags', (route) => route.fulfill({ status: 500, json: { error: { code: 'internal_error' } } }))
  let fail = true
  await page.route('**/api/v1/videos/42/tags', (route) => route.fulfill(fail
    ? { status: 400, json: { error: { code: 'bad_request' } } }
    : { json: { tags: [...fixture.tags, { id: 9, name: 'Rust' }] } }))
  await page.goto('/videos/42')
  await openEditor(page)
  await expect(page.getByLabel('Associations de tags')).toContainText('Déjà associé')
  await expect(page.getByRole('alert')).toContainText('toujours saisir un nom')
  const input = page.getByRole('combobox', { name: 'Rechercher ou ajouter un tag' })
  await input.fill('Rust')
  await input.press('Enter')
  await expect(page.getByText('Saisissez un nom non vide de 200 caractères Unicode maximum.')).toBeVisible()
  await expect(input).toHaveValue('Rust')
  fail = false
  await input.press('Enter')
  await expect(input).toHaveValue('')
  await expect(page.getByLabel('Associations de tags')).toContainText('Rust')
})

test('une mutation lente reste unique et aboutit après fermeture de la modale', async ({ page }) => {
  await mockDetail(page)
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  await page.route('**/api/v1/videos/42/tags', async (route) => {
    calls++
    await gate
    await route.fulfill({ json: { tags: [...fixture.tags, { id: 7, name: 'Rust' }] } })
  })
  await page.goto('/videos/42')
  await openEditor(page)
  const input = page.getByRole('combobox', { name: 'Rechercher ou ajouter un tag' })
  await input.fill('Rust')
  await input.press('Enter')
  await expect(input).toBeDisabled()
  await page.locator('.tag-editor form').evaluate((form) => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await page.getByRole('button', { name: 'Fermer', exact: true }).click()
  release()
  await expect(page.getByRole('link', { name: 'Rust', exact: true })).toBeVisible()
  expect(calls).toBe(1)
  await expect(page.getByRole('button', { name: 'Gérer les tags', exact: true })).toBeFocused()
})

test('un retrait enregistré est distingué de sa relecture en échec', async ({ page }) => {
  await mockDetail(page)
  await page.goto('/videos/42')
  await openEditor(page)
  await page.route('**/api/v1/videos/42', (route) => route.fulfill({ status: 500, json: { error: { code: 'internal_error' } } }))
  await page.route('**/api/v1/videos/42/tags/3', (route) => route.fulfill({ status: 204 }))
  await page.getByRole('button', { name: 'Retirer le tag Déjà associé de cette vidéo' }).click()
  await expect(page.getByRole('alert')).toContainText('Le retrait est enregistré')
  await expect(page.getByText('Aucun tag associé.', { exact: true })).toBeVisible()
  await page.route('**/api/v1/videos/42', (route) => route.fulfill({ json: { ...fixture, tags: [{ id: 8, name: 'Autre onglet' }] } }))
  await page.getByRole('button', { name: 'Actualiser les associations' }).click()
  await expect(page.getByLabel('Associations de tags')).toContainText('Autre onglet')
})

test('les descriptions sont indépendantes, intégrales et utilisables au clavier', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await mockDetail(page)
  const longText = 'Une longue description\n' + 'abc'.repeat(1000)
  await page.route('**/api/v1/videos/42', (route) => route.fulfill({ json: {
    ...fixture,
    sources: [
      fixture.sources[0],
      { ...fixture.sources[0], id: 2, description: longText },
      { ...fixture.sources[0], id: 3, description: '  ' },
    ],
  } }))
  await page.goto('/videos/42')
  const descriptions = page.locator('details')
  await expect(descriptions).toHaveCount(2)
  await expect(descriptions.nth(0)).not.toHaveAttribute('open')
  await descriptions.nth(0).locator('summary').focus()
  await page.keyboard.press('Enter')
  await expect(descriptions.nth(0)).toHaveAttribute('open')
  await expect(descriptions.nth(1)).not.toHaveAttribute('open')
  await descriptions.nth(1).locator('summary').click()
  await expect(descriptions.nth(1).locator('p')).toHaveText(longText)
  await expect(page.getByText('Aucune description disponible.')).toBeVisible()
  await openEditor(page)
  await page.getByRole('button', { name: 'Fermer', exact: true }).click()
  await expect(descriptions.nth(0)).toHaveAttribute('open')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  await page.reload()
  await expect(descriptions.nth(0)).not.toHaveAttribute('open')
})

for (const query of ['tag_id=invalid', 'tag_id=0', 'tag_id=1&tag_id=2']) {
  test(`un filtre invalide reste explicite : ${query}`, async ({ page }) => {
    await page.goto('/?' + query)
    await expect(page.getByRole('alert')).toContainText(/invalide|Un seul filtre/)
    await page.getByRole('button', { name: 'Retirer le filtre' }).click()
    await expect(page).toHaveURL('/')
    await expect(page.getByRole('link', { name: 'Consulter : Comprendre SQLite et ses transactions' })).toBeVisible()
  })
}

test('un filtre inconnu ne prétend pas que toute la bibliothèque est vide', async ({ page }) => {
  await page.goto('/?tag_id=999999999')
  await expect(page.getByRole('heading', { name: 'Aucune vidéo pour ce tag' })).toBeVisible()
  await expect(page.getByText('Filtre actif :')).toContainText('999999999')
  await expect(page.getByRole('heading', { name: 'Votre bibliothèque est encore vide' })).toHaveCount(0)
})

test('une réponse de mutation abandonnée ne modifie pas la fiche suivante', async ({ page }) => {
  await mockDetail(page)
  let release: () => void = () => {}
  let complete: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const done = new Promise<void>((resolve) => { complete = resolve })
  await page.route('**/api/v1/videos/42/tags', async (route) => {
    await gate
    await route.fulfill({ json: { tags: [{ id: 99, name: 'Réponse tardive' }] } })
    complete()
  })
  await page.goto('/videos/42')
  await openEditor(page)
  const input = page.getByRole('combobox', { name: 'Rechercher ou ajouter un tag' })
  await input.fill('Réponse tardive')
  await input.press('Enter')
  await expect(input).toBeDisabled()
  await page.getByRole('button', { name: 'Fermer', exact: true }).click()
  await page.getByRole('link', { name: /Revenir à la bibliothèque/ }).click()
  await page.getByRole('link', { name: 'Consulter : Comprendre SQLite et ses transactions' }).click()
  release()
  await done
  await expect(page.getByLabel('Tags de la vidéo')).not.toContainText('Réponse tardive')
  await expect(page.getByLabel('Tags de la vidéo')).toContainText('SQLite')
})

test('un ancien filtre lent ne remplace pas la sélection suivante', async ({ page }) => {
  let release: () => void = () => {}
  let complete: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const done = new Promise<void>((resolve) => { complete = resolve })
  await page.route('**/api/v1/tags', (route) => route.fulfill({ json: { tags: [
    { id: 101, name: 'Premier filtre' }, { id: 102, name: 'Second filtre' },
  ] } }))
  await page.route('**/api/v1/videos?tag_id=101', async (route) => {
    await gate
    await route.fulfill({ json: { videos: [{ ...fixture, sources: [{ ...fixture.sources[0], title: 'Ancien résultat' }] }] } })
    complete()
  })
  await page.route('**/api/v1/videos?tag_id=102', (route) => route.fulfill({ json: { videos: [fixture] } }))
  await page.goto('/?tag_id=101')
  await expect(page.getByRole('status')).toContainText('Chargement')
  await page.getByLabel('Filtrer par tag').selectOption('102')
  await expect(page.getByRole('heading', { name: 'Vidéo de classement' })).toBeVisible()
  release()
  await done
  await expect(page.getByRole('heading', { name: 'Ancien résultat' })).toHaveCount(0)
  await expect(page.getByText('Filtre actif :')).toContainText('Second filtre')
})

test('un échec de retrait conserve le tag et permet une nouvelle tentative', async ({ page }) => {
  await mockDetail(page)
  let fail = true
  await page.route('**/api/v1/videos/42/tags/3', (route) => route.fulfill(fail
    ? { status: 500, json: { error: { code: 'internal_error' } } }
    : { status: 204 }))
  await page.goto('/videos/42')
  await openEditor(page)
  await page.getByRole('button', { name: 'Retirer le tag Déjà associé de cette vidéo' }).click()
  await expect(page.getByRole('alert')).toContainText('Le serveur a rencontré une erreur')
  await expect(page.getByLabel('Associations de tags')).toContainText('Déjà associé')
  fail = false
  await page.route('**/api/v1/videos/42', (route) => route.fulfill({ json: { ...fixture, tags: [] } }))
  await page.getByRole('button', { name: 'Retirer le tag Déjà associé de cette vidéo' }).click()
  await expect(page.getByText('Aucun tag associé.', { exact: true })).toBeVisible()
})

test('le dialogue garde le clavier dans la modale et restaure le déclencheur', async ({ page }) => {
  await mockDetail(page)
  await page.goto('/videos/42')
  await openEditor(page)
  const last = page.getByRole('button', { name: 'Actualiser les associations' })
  await last.focus()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Fermer', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(last).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Gérer les tags', exact: true })).toBeFocused()
})

test('la bibliothèque reste lisible quand le catalogue échoue', async ({ page }) => {
  await page.route('**/api/v1/tags', (route) => route.fulfill({ status: 500, json: { error: { code: 'internal_error' } } }))
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Consulter : Comprendre SQLite et ses transactions' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('indépendante du catalogue')
  await page.getByRole('button', { name: 'Réessayer les tags' }).click()
  await expect(page.getByRole('link', { name: 'Consulter : Comprendre SQLite et ses transactions' })).toBeVisible()
})
