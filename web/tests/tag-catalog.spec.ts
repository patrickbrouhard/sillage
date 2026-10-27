import { expect, test } from './fixtures'
import type { Page } from '@playwright/test'
import type { CatalogTag } from '../src/api'

const catalog: CatalogTag[] = [
  { id: 4, name: 'Delta', video_count: 0, publisher_count: 0, person_count: 0 },
  { id: 3, name: 'Charlie', video_count: 1, publisher_count: 0, person_count: 0 },
  { id: 2, name: 'Bravo', video_count: 18, publisher_count: 2, person_count: 1 },
  { id: 1, name: 'Alpha', video_count: 0, publisher_count: 1, person_count: 0 },
]

/** Fournit des compteurs déterministes tout en traversant le client REST. */
async function mockCatalog(page: Page, tags = catalog) {
  await page.route('**/api/v1/tags', route => route.fulfill({ json: { tags } }))
}

test('navigation, compteurs directs, recherche locale et trois tris déterministes', async ({ page }) => {
  let reads = 0
  await page.route('**/api/v1/tags', route => { reads++; return route.fulfill({ json: { tags: catalog } }) })
  await page.goto('/')
  await page.getByRole('button', { name: 'Ouvrir la navigation' }).click()
  await page.getByRole('link', { name: 'Tags', exact: true }).click()
  await expect(page).toHaveURL('/tags')
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Tags', exact: true })).toBeVisible()
  const names = page.locator('.tag-catalog-row:visible .tag-catalog-name')
  await expect(names).toHaveText(['Alpha', 'Bravo', 'Charlie', 'Delta'])
  await expect(page.locator('.tag-catalog-row').filter({ hasText: 'Bravo' })).toContainText('18 vidéos · 2 publishers · 1 personne')
  await expect(page.locator('.tag-catalog-row').filter({ hasText: 'Alpha' })).toContainText('1 publisher')
  await expect(page.locator('.tag-catalog-row').filter({ hasText: 'Delta' })).toContainText('Inutilisé')
  const sort = page.getByLabel('Trier par')
  await sort.selectOption('least')
  await expect(names).toHaveText(['Delta', 'Alpha', 'Charlie', 'Bravo'])
  await sort.selectOption('most')
  await expect(names).toHaveText(['Bravo', 'Alpha', 'Charlie', 'Delta'])
  const before = reads
  await page.getByLabel('Rechercher un tag').fill('ALP')
  await expect(names).toHaveText(['Alpha'])
  await page.getByLabel('Rechercher un tag').fill('absent')
  await expect(page.getByText('Aucun tag ne correspond à votre recherche.')).toBeVisible()
  expect(reads).toBe(before)
})

test('renommage sur place, collision persistante, annulation et focus', async ({ page }) => {
  await mockCatalog(page)
  let fail = true
  let sent = ''
  await page.route('**/api/v1/tags/1', route => {
    sent = route.request().postDataJSON().name
    return route.fulfill(fail
      ? { status: 409, json: { error: { code: 'tag_conflict' } } }
      : { json: { id: 1, name: 'École' } })
  })
  await page.goto('/tags')
  const trigger = page.getByRole('button', { name: 'Renommer le tag Alpha', exact: true })
  await trigger.click()
  const input = page.getByRole('textbox', { name: 'Nom du tag' })
  await expect(input).toBeFocused()
  expect(await input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([0, 5])
  await input.fill('Bravo')
  await input.press('Enter')
  await expect(page.getByRole('alert')).toContainText('Un autre tag porte déjà ce nom')
  await expect(input).toHaveValue('Bravo')
  await expect(input).toBeFocused()
  await input.press('Escape')
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(input).toHaveValue('Alpha')
  await page.getByRole('button', { name: 'Annuler', exact: true }).click()
  await expect(trigger).toBeFocused()
  await trigger.click()
  fail = false
  await input.fill(' École ')
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click()
  expect(sent).toBe(' École ')
  await expect(input).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Renommer le tag École', exact: true })).toBeFocused()
  await expect(page.locator('.tag-catalog-row:visible .tag-catalog-name')).toHaveText(['Bravo', 'Charlie', 'Delta', 'École'])
  await expect(page.locator('.tag-catalog-row').filter({ hasText: 'École' })).toContainText('1 publisher')
})

for (const [stored, searched] of [['Cafe\u0301', 'Café'], ['Café', 'Cafe\u0301']]) {
  test(`recherche NFC : ${JSON.stringify(stored)} depuis ${JSON.stringify(searched)}, accents conservés`, async ({ page }) => {
    await mockCatalog(page, [
      { ...catalog[0], name: stored },
      { ...catalog[1], name: 'Cafe' },
    ])
    await page.goto('/tags')
    const search = page.getByLabel('Rechercher un tag')
    const names = page.locator('.tag-catalog-row:visible .tag-catalog-name')
    await search.fill(searched)
    await expect(names).toHaveText([stored])
    // NFC ne retire pas les accents : une recherche complète accentuée exclut Cafe.
    await search.fill('CAFÉ')
    await expect(names).toHaveText([stored])
    await search.fill('Cafe')
    await expect(names).toHaveText(['Cafe'])
  })
}

test('une mutation lente reste unique et aboutit après un changement de filtre', async ({ page }) => {
  await mockCatalog(page)
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  await page.route('**/api/v1/tags/1', async route => {
    calls++
    await gate
    await route.fulfill({ json: { id: 1, name: 'Nouveau' } })
  })
  await page.goto('/tags')
  await page.getByRole('button', { name: 'Renommer le tag Alpha', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'Nom du tag' })
  await input.fill('Nouveau')
  await input.press('Enter')
  await expect(page.getByRole('button', { name: 'Enregistrement…' })).toBeDisabled()
  await page.locator('.tag-rename').evaluate(form => {
    for (let i = 0; i < 2; i++) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await page.getByLabel('Rechercher un tag').fill('Bravo')
  const sort = page.getByLabel('Trier par')
  await sort.selectOption('most')
  await sort.focus()
  release()
  await expect(page.getByRole('status')).toContainText('Tag renommé : Nouveau')
  await expect(sort).toBeFocused()
  await page.getByLabel('Rechercher un tag').fill('')
  await expect(page.getByText('Nouveau', { exact: true })).toBeVisible()
  expect(calls).toBe(1)
})

test('confirmation de suppression, Échap, échec réessayable et mise à jour locale', async ({ page }) => {
  await mockCatalog(page)
  let fail = true
  let calls = 0
  await page.route('**/api/v1/tags/2', route => {
    calls++
    return route.fulfill(fail ? { status: 500, json: { error: { code: 'internal_error' } } } : { status: 204 })
  })
  await page.goto('/tags')
  const trigger = page.getByRole('button', { name: 'Supprimer le tag Bravo', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Supprimer « Bravo » ?' })
  await expect(dialog).toContainText('18 vidéos · 2 publishers · 1 personne')
  await expect(dialog.getByRole('button', { name: 'Annuler' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
  expect(calls).toBe(0)
  await trigger.click()
  await dialog.getByRole('button', { name: 'Supprimer', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Le serveur a rencontré une erreur')
  await expect(trigger).toHaveCount(1)
  fail = false
  await dialog.getByRole('button', { name: 'Supprimer', exact: true }).click()
  await expect(trigger).toHaveCount(0)
  await expect(page.getByLabel('Rechercher un tag')).toBeFocused()
  await expect(page.getByRole('status')).toContainText('Tag supprimé : Bravo')
})

test('chargement, erreur réessayable et catalogue vide', async ({ page }) => {
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/v1/tags', async route => {
    await gate
    await route.fulfill({ status: 500, json: { error: { code: 'internal_error' } } })
  })
  await page.goto('/tags')
  await expect(page.getByRole('status')).toHaveText('Chargement des tags…')
  release()
  await expect(page.getByRole('alert')).toContainText('Le serveur a rencontré une erreur')
  await mockCatalog(page, [])
  await page.getByRole('button', { name: 'Réessayer le catalogue' }).click()
  await expect(page.getByRole('heading', { name: 'Aucun tag dans le catalogue' })).toBeVisible()
})

for (const theme of ['light', 'dark']) {
  test(`lignes mobiles, noms longs, clavier et thème ${theme}`, async ({ page }, info) => {
    const name = 'É'.repeat(200)
    await mockCatalog(page, [{ ...catalog[1], name }])
    await page.addInitScript(value => localStorage.setItem('sillage.theme', value), theme)
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/tags')
    await page.getByRole('button', { name: `Renommer le tag ${name}`, exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('textbox', { name: 'Nom du tag' })).toBeFocused()
    await page.screenshot({ path: info.outputPath(`catalog-${theme}-mobile.png`) })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: `Supprimer le tag ${name}`, exact: true }).click()
    await expect(page.getByRole('dialog', { name: `Supprimer « ${name} » ?` })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath(`catalog-delete-${theme}-mobile.png`) })
  })
}

test('catalogue réel : Unicode, liens des trois entités, renommage, FTS et suppression', async ({ page, request }, info) => {
  const run = `${info.repeatEachIndex}-${info.retry}`
  const name = `Straße catalogue ${run}`
  const renamed = `CatalogueRenomme ${run}`
  const videos = []
  for (const suffix of ['a', 'b', 'c']) {
    const response = await request.post('/api/v1/videos', { data: { url: `https://youtu.be/sillage-tags-catalog-${run}-${suffix}` } })
    expect(response.status()).toBe(201)
    videos.push(await response.json())
  }
  const publisherID = videos[0].sources[0].publisher.id
  const person = await (await request.post('/api/v1/persons', { data: { name: 'Catalogue' } })).json()
  for (const path of [`videos/${videos[0].id}`, `videos/${videos[1].id}`, `publishers/${publisherID}`, `persons/${person.id}`]) {
    expect((await request.post(`/api/v1/${path}/tags`, { data: { names: [name] } })).status()).toBe(200)
  }
  const original = (await (await request.get('/api/v1/tags')).json()).tags.find((tag: CatalogTag) => tag.name === name)
  await page.goto('/tags')
  await page.getByLabel('Rechercher un tag').fill(name)
  await expect(page.locator('.tag-catalog-row:visible')).toContainText('2 vidéos · 1 publisher · 1 personne')
  await page.getByRole('button', { name: `Renommer le tag ${name}`, exact: true }).click()
  await page.getByRole('textbox', { name: 'Nom du tag' }).fill(name.toUpperCase())
  await page.keyboard.press('Enter')
  await expect(page.getByRole('status')).toContainText(`Tag renommé : ${name.toUpperCase()}`)
  await page.getByLabel('Rechercher un tag').fill(name.toUpperCase())
  await expect(page.getByRole('button', { name: `Renommer le tag ${name.toUpperCase()}`, exact: true })).toBeVisible()
  await page.getByRole('button', { name: `Renommer le tag ${name.toUpperCase()}`, exact: true }).click()
  await page.getByRole('textbox', { name: 'Nom du tag' }).fill(renamed)
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('Rechercher un tag')).toBeFocused()
  await page.getByLabel('Rechercher un tag').fill(renamed)
  const updated = (await (await request.get('/api/v1/tags')).json()).tags.find((tag: CatalogTag) => tag.id === original.id)
  expect(updated).toEqual({ ...original, name: renamed })
  const search = await (await request.get('/api/v1/search?q=CatalogueRenomme')).json()
  expect(search.results.map((result: { video: { id: number } }) => result.video.id).sort()).toEqual([videos[0].id, videos[1].id].sort())
  await page.getByRole('button', { name: `Supprimer le tag ${renamed}`, exact: true }).click()
  // Le compteur affiché n'est pas une précondition de suppression.
  await request.post(`/api/v1/videos/${videos[2].id}/tags`, { data: { names: [renamed] } })
  await page.getByRole('dialog', { name: `Supprimer « ${renamed} » ?` }).getByRole('button', { name: 'Supprimer', exact: true }).click()
  await expect(page.getByRole('status')).toContainText(`Tag supprimé : ${renamed}`)
  for (const path of [...videos.map(video => `videos/${video.id}`), `publishers/${publisherID}`, `persons/${person.id}`]) {
    const response = await request.get(`/api/v1/${path}`)
    expect(response.status()).toBe(200)
    expect((await response.json()).tags.some((tag: { id: number }) => tag.id === original.id)).toBe(false)
  }
  expect((await (await request.get('/api/v1/search?q=CatalogueRenomme')).json()).total).toBe(0)
  const reused = await request.post(`/api/v1/videos/${videos[0].id}/tags`, { data: { names: [name] } })
  expect((await reused.json()).tags[0].id).not.toBe(original.id)
})
