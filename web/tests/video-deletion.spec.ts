import type { APIRequestContext, Page } from '@playwright/test'
import { test, expect } from './fixtures'

/** Chaque scénario possède sa vidéo afin de ne pas supprimer les fixtures partagées. */
async function openVideo(page: Page, request: APIRequestContext, external: string) {
  const response = await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/' + external } })
  expect(response.ok()).toBeTruthy()
  const video = await response.json()
  await request.put(`/api/v1/videos/${video.id}/note`, { data: { content_md: 'Texte initial', expected_revision: 0 } })
  await page.goto('/videos/' + video.id)
  await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toContainText('Texte initial')
  return video
}

/** Ouvre la confirmation placée à la fin du panneau Informations. */
async function confirmDialog(page: Page) {
  await page.getByRole('tab', { name: 'Informations', exact: true }).click()
  await page.getByRole('button', { name: 'Supprimer la vidéo', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Supprimer définitivement cette vidéo ?' })).toBeVisible()
}

test('suppression réelle, absence des connaissances et idempotence', async ({ page, request }) => {
  const video = await openVideo(page, request, 'trdelvid001')
  const prefix = `/api/v1/videos/${video.id}`
  await request.post(prefix + '/tags', { data: { names: ['tag-conserve-suppression'] } })
  await request.post(prefix + `/sources/${video.sources[0].id}/transcript`)
  await request.put(prefix + `/sources/${video.sources[0].id}/playback-progress`, { data: { position_ms: 1250 } })
  await confirmDialog(page)
  await expect(page.getByRole('dialog')).toContainText('irréversible')
  await page.getByRole('button', { name: 'Supprimer définitivement', exact: true }).click()
  await expect(page).toHaveURL('/')
  await expect(page.getByRole('status').filter({ hasText: 'Vidéo supprimée définitivement.' })).toBeVisible()
  for (const suffix of ['', '/note', '/assets']) expect((await request.get(prefix + suffix)).status()).toBe(404)
  expect((await request.delete(prefix)).status()).toBe(204)
  expect(await (await request.get('/api/v1/tags')).text()).toContain('tag-conserve-suppression')
  await expect(page.getByRole('dialog', { name: 'Quitter la note ?' })).toHaveCount(0)
})

test('annuler conserve le brouillon et Undo sans écriture causée par le dialogue', async ({ page, request }) => {
  await openVideo(page, request, 'trdelvid002')
  await page.clock.install()
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await editor.fill('Brouillon à conserver')
  await confirmDialog(page)
  await expect(page.getByRole('dialog')).toContainText('brouillon local')
  await page.getByRole('button', { name: 'Annuler', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Supprimer la vidéo', exact: true })).toBeFocused()
  await page.getByRole('tab', { name: 'Note', exact: true }).click()
  await expect(editor).toContainText('Brouillon à conserver')
  await editor.focus()
  await page.keyboard.press('Control+z')
  await expect(editor).toContainText('Texte initial')
})

test('refus occupé reprend la même session et son autosauvegarde', async ({ page, request }) => {
  const video = await openVideo(page, request, 'trdelvid003')
  await page.clock.install()
  await page.route(`**/api/v1/videos/${video.id}`, async route => {
    if (route.request().method() === 'DELETE') await route.fulfill({ status: 409, json: { error: { code: 'video_busy' } } })
    else await route.continue()
  })
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await editor.fill('Brouillon après refus')
  await confirmDialog(page)
  await page.getByRole('button', { name: 'Supprimer définitivement', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Vidéo occupée')
  await page.getByRole('button', { name: 'Annuler', exact: true }).click()
  await page.getByRole('tab', { name: 'Note', exact: true }).click()
  await expect(editor).toContainText('Brouillon après refus')
  await page.clock.runFor(2100)
  await expect.poll(async () => (await (await request.get(`/api/v1/videos/${video.id}/note`)).json()).content_md).toBe('Brouillon après refus')
})

test('réponse perdue conserve le brouillon et suspend les PUT jusqu’à réconciliation', async ({ page, request }) => {
  const video = await openVideo(page, request, 'trdelvid004')
  await page.clock.install()
  let deletes = 0
  let writes = 0
  await page.route(`**/api/v1/videos/${video.id}/note`, async route => {
    if (route.request().method() === 'PUT') writes++
    await route.continue()
  })
  await page.route(`**/api/v1/videos/${video.id}`, async route => {
    if (route.request().method() !== 'DELETE') return route.continue()
    deletes++
    if (deletes === 1) { await route.fetch(); await route.abort('failed') }
    else await route.continue()
  })
  await page.getByRole('textbox', { name: 'Note Markdown' }).fill('Brouillon incertain')
  await confirmDialog(page)
  await page.getByRole('button', { name: 'Supprimer définitivement', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Réponse incertaine')
  await expect(page.getByRole('button', { name: 'Annuler', exact: true })).toBeDisabled()
  await page.clock.runFor(25_000)
  expect(writes).toBe(0)
  expect((await request.get(`/api/v1/videos/${video.id}`)).status()).toBe(404)
  await page.getByRole('button', { name: 'Vérifier et réessayer' }).click()
  await expect(page).toHaveURL('/')
  expect(deletes).toBe(2)
  expect(writes).toBe(0)
})

test('purge incomplète visible après rechargement et réessayable sans recréer la vidéo', async ({ page, request }) => {
  const video = await openVideo(page, request, 'trdelvid005')
  let calls = 0
  await page.route(`**/api/v1/videos/${video.id}`, async route => {
    if (route.request().method() !== 'DELETE') return route.continue()
    calls++
    await route.fetch()
    if (calls === 1) await route.fulfill({ status: 202, json: { status: 'purge_pending' } })
    else await route.fulfill({ status: 204 })
  })
  await confirmDialog(page)
  await page.getByRole('button', { name: 'Supprimer définitivement', exact: true }).click()
  await expect(page).toHaveURL('/')
  await expect(page.getByRole('complementary', { name: 'Résultat de suppression' })).toContainText('nettoyage des fichiers reste à terminer')
  await page.reload()
  await page.getByRole('button', { name: 'Réessayer le nettoyage' }).click()
  await expect(page.getByRole('complementary', { name: 'Résultat de suppression' })).toContainText('Vidéo supprimée définitivement.')
  expect(calls).toBe(2)
})

test('sauvegarde en vol terminée avant DELETE, sans flush de navigation supplémentaire', async ({ page, request }) => {
  const video = await openVideo(page, request, 'trdelvid006')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let writes = 0
  let deletes = 0
  await page.route(`**/api/v1/videos/${video.id}/note`, async route => {
    if (route.request().method() === 'PUT') { writes++; await gate }
    await route.continue()
  })
  await page.route(`**/api/v1/videos/${video.id}`, async route => {
    if (route.request().method() === 'DELETE') deletes++
    await route.continue()
  })
  await page.getByRole('textbox', { name: 'Note Markdown' }).fill('En vol')
  await page.keyboard.press('Control+s')
  await expect.poll(() => writes).toBe(1)
  await confirmDialog(page)
  await page.getByRole('button', { name: 'Supprimer définitivement', exact: true }).click()
  await expect(page.getByText('Suppression en cours…', { exact: true })).toBeVisible()
  expect(deletes).toBe(0)
  release()
  await expect(page).toHaveURL('/')
  expect(writes).toBe(1)
  expect(deletes).toBe(1)
})

test('un conflit de note ne contraint pas à sauvegarder avant la destruction', async ({ page, request }) => {
  const video = await openVideo(page, request, 'trdelvid007')
  await request.put(`/api/v1/videos/${video.id}/note`, { data: { content_md: 'Autre onglet', expected_revision: 1 } })
  await page.getByRole('textbox', { name: 'Note Markdown' }).fill('Conflit local')
  await page.keyboard.press('Control+s')
  await expect(page.getByRole('region', { name: 'Résolution du conflit' })).toBeVisible()
  await confirmDialog(page)
  await page.getByRole('button', { name: 'Supprimer définitivement', exact: true }).click()
  await expect(page).toHaveURL('/')
})

test('lecture locale déchargée et point de reprise non réémis après suppression', async ({ page, request }) => {
  const video = await openVideo(page, request, 'trlpdel0008')
  const prefix = `/api/v1/videos/${video.id}`
  const source = prefix + `/sources/${video.sources[0].id}`
  await request.post(source + '/download')
  await expect.poll(async () => (await (await request.get(source + '/download')).json()).status).toBe('available')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Local', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('video')).toBeVisible()
  let deleting = false
  let lateWrites = 0
  await page.route('**/playback-progress', async route => {
    if (deleting && route.request().method() === 'PUT') lateWrites++
    await route.continue()
  })
  await page.route('**' + prefix, async route => {
    if (route.request().method() === 'DELETE') deleting = true
    await route.continue()
  })
  await confirmDialog(page)
  await page.getByRole('button', { name: 'Supprimer définitivement', exact: true }).click()
  await expect(page).toHaveURL('/')
  expect(lateWrites).toBe(0)
})

test('DELETE exige une session et le jeton CSRF', async ({ playwright, request, baseURL }) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trdelvid009' } })).json()
  const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
  expect((await anonymous.delete('/api/v1/videos/' + video.id)).status()).toBe(401)
  await anonymous.dispose()
  const withoutCSRF = await playwright.request.newContext({ baseURL, storageState: 'tests/.auth/state.json' })
  expect((await withoutCSRF.delete('/api/v1/videos/' + video.id)).status()).toBe(403)
  await withoutCSRF.dispose()
  expect((await request.get('/api/v1/videos/' + video.id)).status()).toBe(200)
})

for (const mobile of [false, true]) {
  test('confirmation accessible sans débordement : ' + (mobile ? 'mobile' : 'desktop'), async ({ page, request }, info) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: mobile ? 'dark' : 'light' })
    await openVideo(page, request, mobile ? 'trdelvid011' : 'trdelvid010')
    await confirmDialog(page)
    await expect(page.getByRole('button', { name: 'Annuler', exact: true })).toBeFocused()
    const bounds = await page.getByRole('dialog').boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    await page.screenshot({ path: info.outputPath('confirmation.png') })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).not.toBeVisible()
    await expect(page.getByRole('button', { name: 'Supprimer la vidéo', exact: true })).toBeFocused()
  })
}

test('un refus après une réponse perdue ne relance pas l’autosauvegarde', async ({ page, request }) => {
  const video = await openVideo(page, request, 'trdelvid012')
  await page.clock.install()
  let calls = 0
  let writes = 0
  await page.route(`**/api/v1/videos/${video.id}/note`, async route => {
    if (route.request().method() === 'PUT') writes++
    await route.continue()
  })
  await page.route(`**/api/v1/videos/${video.id}`, async route => {
    if (route.request().method() !== 'DELETE') return route.continue()
    calls++
    if (calls === 1) await route.abort('failed')
    else if (calls === 2) await route.fulfill({ status: 409, json: { error: { code: 'video_busy' } } })
    else await route.continue()
  })
  await page.getByRole('textbox', { name: 'Note Markdown' }).fill('À protéger')
  await confirmDialog(page)
  await page.getByRole('button', { name: 'Supprimer définitivement', exact: true }).click()
  await page.getByRole('button', { name: 'Vérifier et réessayer' }).click()
  await expect(page.getByRole('button', { name: 'Annuler', exact: true })).toBeDisabled()
  await page.clock.runFor(25_000)
  expect(writes).toBe(0)
  await page.getByRole('button', { name: 'Vérifier et réessayer' }).click()
  await expect(page).toHaveURL('/')
})
