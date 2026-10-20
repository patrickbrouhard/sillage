import type { APIRequestContext, Page } from '@playwright/test'
import { test, expect } from './fixtures'

/** Prépare la note réelle et contrôle uniquement l'acceptation et la génération distantes. */
async function setup(page: Page, request: APIRequestContext, content = 'alpha omega') {
  const externalID = 'tr72' + test.info().testId.slice(-7)
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/' + externalID } })).json()
  const noteURL = `/api/v1/videos/${video.id}/note`
  await request.put(noteURL, { data: { content_md: content, expected_revision: 0 } })
  const asset = {
    id: 900, video_id: video.id, source_id: video.sources[0].id, timestamp_ms: 12345,
    type: 'screenshot', status: 'pending', error_code: '', created_at: '2026-10-17T12:00:00.000Z',
  }
  let accept!: () => void
  const gate = new Promise<void>(resolve => { accept = resolve })
  let posts = 0
  const keys: string[] = []
  await page.route('**/captures', async route => {
    posts++
    const body = route.request().postDataJSON()
    keys.push(body.request_id)
    expect(body.timestamp_ms).toBe(12345)
    await gate
    await route.fulfill({ status: 202, json: asset })
  })
  await page.route('**/api/v1/assets/900', route => route.fulfill({ json: asset }))
  await page.route('**/api/v1/assets/900/content', route => route.fulfill({
    contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64'),
  }))
  await page.goto(`/videos/${video.id}`)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  await page.evaluate(() => {
    const player = window.youtubeTest.players.at(-1)!
    player.position = 12.345
    player.emitState(2)
  })
  return { editor, noteURL, asset, accept, posts: () => posts, keys }
}

test('marqueur immédiat sans sauvegarde, saisie et Undo/Redo conservés, insertion définitive isolée', async ({ page, request }) => {
  const c = await setup(page, request)
  await c.editor.click()
  await page.keyboard.press('Control+End')
  await page.getByRole('button', { name: '+ Capture', exact: true }).click()
  await expect(page.locator('.capture-marker')).toHaveText('Capture à 0:12 — préparation…')
  await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeDisabled()
  await page.screenshot({ path: test.info().outputPath('capture-marker.png') })
  await page.keyboard.type(' suite')
  await page.keyboard.press('Control+z')
  await expect(page.locator('.capture-marker')).toBeVisible()
  await page.keyboard.press('Control+Shift+Z')
  await expect(c.editor).toContainText(' suite')
  await page.keyboard.press('Control+s')
  await expect.poll(async () => (await (await request.get(c.noteURL)).json()).content_md).toBe('alpha omega suite')
  // Le retour réseau n'a pas le droit de reprendre le focus.
  const save = page.getByRole('button', { name: 'Enregistrer la note', exact: true })
  await save.focus()
  c.accept()
  await expect(page.locator('.capture-marker')).toHaveCount(0)
  await expect(save).toBeFocused()
  const markdown = '![Capture à 0:12](/api/v1/assets/900/content) '
  await page.keyboard.press('Control+s')
  await expect.poll(async () => (await (await request.get(c.noteURL)).json()).content_md).toBe('alpha omega' + markdown + ' suite')
  await c.editor.focus()
  await page.keyboard.press('Control+z')
  await expect(c.editor).toHaveText('alpha omega suite')
  await page.keyboard.press('Control+Shift+Z')
  await expect(c.editor).toContainText(markdown.trim())
  expect(c.posts()).toBe(1)
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
})

test('suppression traversant l’ancrage puis Undo ne ressuscitent pas la capture', async ({ page, request }) => {
  const c = await setup(page, request)
  await c.editor.click()
  await page.keyboard.press('Control+Home')
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
  await page.getByRole('button', { name: '+ Capture', exact: true }).click()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Backspace')
  await expect(page.locator('.capture-marker')).toHaveCount(0)
  await page.keyboard.press('Control+z')
  await expect(c.editor).toHaveText('alpha omega')
  c.accept()
  await expect(page.getByRole('alert')).toContainText('insertion abandonnée')
  await expect(c.editor).not.toContainText('/assets/')
})

test('Lecture pendant génération puis affichage automatique du PNG', async ({ page, request }) => {
  const c = await setup(page, request, '')
  await page.getByRole('button', { name: '+ Capture', exact: true }).click()
  c.accept()
  await expect(page.locator('.capture-marker')).toHaveCount(0)
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await expect(page.getByLabel('Lecture de la note')).toContainText('en cours de génération')
  c.asset.status = 'available'
  await expect(page.getByLabel('Lecture de la note').locator('img')).toBeVisible()
  await expect(page.getByRole('button', { name: '+ Capture', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Édition', exact: true }).click()
  await expect(page.getByRole('button', { name: '+ Capture', exact: true })).toBeEnabled()
})

test('échec après insertion conserve le Markdown et Undo retire uniquement la référence', async ({ page, request }) => {
  const c = await setup(page, request, '')
  await page.getByRole('button', { name: '+ Capture', exact: true }).click()
  c.accept()
  await expect(c.editor).toContainText('/api/v1/assets/900/content')
  c.asset.status = 'failed'
  c.asset.error_code = 'capture_failed'
  await expect(page.getByRole('alert')).toContainText('génération de la capture a échoué')
  await expect(c.editor).toContainText('/api/v1/assets/900/content')
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await expect(page.getByLabel('Lecture de la note')).toContainText('a échoué')
})

test('réponse perdue récupérée par clé sans second POST', async ({ page, request }) => {
  const c = await setup(page, request, '')
  await page.route('**/captures', async route => {
    c.keys.push(route.request().postDataJSON().request_id)
    await route.abort('failed')
  })
  await page.route('**/api/v1/assets/requests/*', async route => {
    expect(route.request().url().split('/').at(-1)).toBe(c.keys[0])
    await route.fulfill({ json: c.asset })
  })
  await page.getByRole('button', { name: '+ Capture', exact: true }).click()
  await expect(c.editor).toContainText('/api/v1/assets/900/content')
  expect(c.keys).toHaveLength(1)
})

test('départ pendant acceptation ne provoque aucune insertion dans la fiche suivante', async ({ page, request }) => {
  const c = await setup(page, request)
  await page.getByRole('button', { name: '+ Capture', exact: true }).click()
  await expect(page.locator('.capture-marker')).toBeVisible()
  await page.getByRole('link', { name: 'Sillage, accueil', exact: true }).first().click()
  await expect(page).toHaveURL('/')
  c.accept()
  await page.goto(c.noteURL.replace('/api/v1', '').replace('/note', ''))
  await expect(c.editor).toHaveText('alpha omega')
  await expect(page.locator('.capture-marker')).toHaveCount(0)
})

test('position indisponible refuse avant le marqueur et la requête', async ({ page, request }) => {
  const c = await setup(page, request)
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(3))
  await page.getByRole('button', { name: '+ Capture', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Temps indisponible')
  expect(c.posts()).toBe(0)
  await expect(page.locator('.capture-marker')).toHaveCount(0)
  c.accept()
})

test('remplacement de la session après conflit invalide le marqueur', async ({ page, request }) => {
  const c = await setup(page, request)
  await c.editor.click()
  await page.keyboard.press('Control+End')
  await page.getByRole('button', { name: '+ Capture', exact: true }).click()
  const current = await (await request.get(c.noteURL)).json()
  await request.put(c.noteURL, { data: { content_md: 'version serveur', expected_revision: current.revision } })
  await page.keyboard.type(' locale')
  await page.keyboard.press('Control+s')
  await expect(page.getByRole('region', { name: 'Résolution du conflit' })).toBeVisible()
  await page.getByRole('button', { name: 'Conserver la version serveur', exact: true }).click()
  await expect(c.editor).toHaveText('version serveur')
  c.accept()
  await expect(page.getByRole('alert')).toContainText('insertion abandonnée')
  await expect(c.editor).toHaveText('version serveur')
})

test('sélection préservée et caret courant conservé après la réponse', async ({ page, request }) => {
  const c = await setup(page, request)
  await c.editor.click()
  await page.keyboard.press('Control+Home')
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight')
  await page.getByRole('button', { name: '+ Capture', exact: true }).click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' suite')
  c.accept()
  await expect(page.locator('.capture-marker')).toHaveCount(0)
  await page.keyboard.type(' fin')
  await page.keyboard.press('Control+s')
  await expect.poll(async () => (await (await request.get(c.noteURL)).json()).content_md)
    .toBe('alpha![Capture à 0:12](/api/v1/assets/900/content)  omega suite fin')
})

test('contenu indisponible ne devient pas un échec de génération', async ({ page, request }) => {
  const c = await setup(page, request, '')
  c.asset.status = 'available'
  await page.route('**/api/v1/assets/900/content', route => route.fulfill({ status: 409, json: { error: { code: 'asset_content_unavailable' } } }))
  await page.getByRole('button', { name: '+ Capture', exact: true }).click()
  c.accept()
  await expect(c.editor).toContainText('/api/v1/assets/900/content')
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await expect(page.getByLabel('Lecture de la note')).toContainText('image générée est actuellement indisponible')
  await expect(page.getByLabel('Lecture de la note')).not.toContainText('génération de cette capture a échoué')
})

test('reprise du POST incertain conserve la même clé de demande', async ({ page, request }) => {
  const c = await setup(page, request, '')
  await page.route('**/captures', async route => {
    c.keys.push(route.request().postDataJSON().request_id)
    if (c.keys.length === 1) await route.abort('failed')
    else await route.fulfill({ status: 202, json: c.asset })
  })
  await page.route('**/api/v1/assets/requests/*', route => route.fulfill({ status: 404, json: { error: { code: 'asset_not_found' } } }))
  await page.getByRole('button', { name: '+ Capture', exact: true }).click()
  await expect(c.editor).toContainText('/api/v1/assets/900/content')
  expect(c.keys).toHaveLength(2)
  expect(c.keys[0]).toBe(c.keys[1])
})

test('curseur après la référence et son espace lorsque la position attend au marqueur', async ({ page, request }) => {
  const c = await setup(page, request, '')
  await page.getByRole('button', { name: '+ Capture', exact: true }).click()
  c.accept()
  await expect(c.editor).toContainText('/api/v1/assets/900/content')
  await page.keyboard.type('suite')
  await page.keyboard.press('Control+s')
  await expect.poll(async () => (await (await request.get(c.noteURL)).json()).content_md)
    .toBe('![Capture à 0:12](/api/v1/assets/900/content) suite')
})

test('capture acceptée pendant Informations sans changement de panneau ni de focus', async ({ page, request }) => {
  const c = await setup(page, request)
  await c.editor.click()
  await page.keyboard.press('Control+End')
  await page.getByRole('button', { name: '+ Capture', exact: true }).click()
  const information = page.getByRole('tab', { name: 'Informations', exact: true })
  await information.click()
  c.accept()
  await expect(page.locator('.capture-marker')).toHaveCount(0)
  await expect(information).toBeFocused()
  await expect(information).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Control+s')
  await expect.poll(async () => (await (await request.get(c.noteURL)).json()).content_md).toContain('/api/v1/assets/900/content')
  await page.getByRole('tab', { name: 'Note', exact: true }).click()
  await expect(c.editor).toContainText('/api/v1/assets/900/content')
  await c.editor.focus()
  await page.keyboard.press('Control+z')
  await expect(c.editor).toHaveText('alpha omega')
})
