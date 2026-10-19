import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

const file = { id: 17, format: 'mkv', size: 2_000_000, duration_ms: 125_000, added_at: '2026-10-15T12:00:00.000Z', video_codec: 'av1', audio_codec: 'opus', width: 1080, height: 1920, fps: 29.97003, audio_language: 'en-US' }
const absent = { status: 'not_downloaded', media_file: null, error: null }
const active = { status: 'downloading', media_file: null, error: null }
const available = { status: 'available', media_file: file, error: null }
const failed = { status: 'failed', media_file: null, error: { code: 'download_failed', message: 'internal' } }

/** Ouvre uniquement le déclencheur de conservation, sans commande au lecteur. */
async function local(page: Page) {
  await page.getByRole('button', { name: 'Local', exact: true }).click()
}

/** La corbeille est accessible par les informations contextuelles du fichier. */
async function remove(page: Page) {
  await page.getByRole('button', { name: 'Informations', exact: true }).click()
  await page.getByRole('button', { name: 'Supprimer le fichier local', exact: true }).click()
}

test('téléchargement réel, rechargement et suppression préservent la connaissance', async ({ page, request }) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trdl0000001' } })).json()
  const noteURL = `/api/v1/videos/${video.id}/note`
  const downloadURL = `/api/v1/videos/${video.id}/sources/${video.sources[0].id}/download`
  await request.put(noteURL, { data: { content_md: 'Connaissance durable', expected_revision: 0 } })
  await page.goto(`/videos/${video.id}`)
  await local(page)
  await page.getByRole('button', { name: 'Télécharger le fichier local', exact: true }).click()
  await expect.poll(async () => (await (await request.get(downloadURL)).json()).status).toBe('available')
  await expect(page.locator('.download-indicator.success')).toBeVisible()
  await expect(page.getByRole('button', { name: 'YouTube', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const downloaded = (await (await request.get(downloadURL)).json()).media_file
  expect(downloaded).toMatchObject({ format: 'mkv', video_codec: 'h264', audio_codec: 'aac', width: 640, height: 360, audio_language: 'fr-FR' })
  expect(downloaded.fps).toBeCloseTo(30000 / 1001)
  await page.getByText('Métadonnées et sources', { exact: true }).click()
  const metadata = page.getByRole('region', { name: 'Fichier local', exact: true })
  await expect(metadata).toContainText('640 × 360')
  await expect(metadata).toContainText('fr-FR')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Local', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.download-indicator.success')).toHaveCount(0)
  await remove(page)
  await expect(page.getByRole('dialog')).toContainText('les notes, les transcriptions et les captures restent conservées')
  await page.getByRole('button', { name: 'Annuler', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Informations', exact: true })).toBeFocused()
  expect((await (await request.get(downloadURL)).json()).status).toBe('available')
  await remove(page)
  await page.getByRole('button', { name: 'Confirmer la suppression' }).click()
  await expect(page.getByText(/Aucun fichier local\. Téléchargez/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Local', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Télécharger le fichier local', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Télécharger cette vidéo')
  await page.getByRole('button', { name: 'Annuler', exact: true }).click()
  expect((await (await request.get(noteURL)).json()).content_md).toBe('Connaissance durable')
})

test('modale, annulation et acquisition conservent lecture YouTube, focus, note et instance', async ({ page, request }) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trdl0000002' } })).json()
  let status: typeof absent | typeof available = absent
  let posts = 0
  await page.route('**/download', route => {
    if (route.request().method() === 'POST') { posts++; status = active }
    return route.fulfill({ json: status })
  })
  await page.goto(`/videos/${video.id}`)
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.youtubeTest?.players.length ?? 0)).toBe(1)
  await page.evaluate(() => { const p = window.youtubeTest.players[0]; p.position = 31; p.emitState(1) })
  const iframe = await page.locator('iframe').elementHandle()
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await editor.fill('Une note en cours')
  const editorNode = await editor.elementHandle()
  await local(page)
  await expect(page.getByRole('button', { name: 'Annuler', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Local', exact: true })).toBeFocused()
  expect(posts).toBe(0)
  await local(page)
  await page.getByRole('button', { name: 'Télécharger le fichier local', exact: true }).dblclick()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.download-indicator.progress')).toBeVisible()
  await local(page)
  await expect(page.getByRole('dialog')).toContainText('Téléchargement en cours')
  await expect(page.getByRole('button', { name: 'Télécharger le fichier local', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  status = available
  await expect(page.locator('.download-indicator.success')).toBeVisible()
  expect(posts).toBe(1)
  expect(await iframe!.evaluate(n => n === document.querySelector('iframe'))).toBe(true)
  expect(await editorNode!.evaluate(n => n === document.querySelector('.cm-content'))).toBe(true)
  expect(await page.evaluate(() => ({ state: window.youtubeTest.players[0].state, pauses: window.youtubeTest.players[0].pauseCalls }))).toEqual({ state: 1, pauses: 0 })
  await expect.poll(async () => (await (await request.get(`/api/v1/videos/${video.id}/note`)).json()).content_md).toBe('Une note en cours')
})

test('réponse POST perdue relue sans nouvelle acquisition ; spinner retrouvé après navigation', async ({ page, request }) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trdl0000003' } })).json()
  let status: typeof absent | typeof available = absent
  let posts = 0
  await page.route('**/download', route => {
    if (route.request().method() === 'POST') { posts++; status = active; return route.abort() }
    return route.fulfill({ json: status })
  })
  await page.goto(`/videos/${video.id}`)
  await local(page)
  await page.getByRole('button', { name: 'Télécharger le fichier local', exact: true }).click()
  await expect(page.locator('.download-indicator.progress')).toBeVisible()
  await page.reload()
  await expect(page.locator('.download-indicator.progress')).toBeVisible()
  await expect(page.locator('.download-indicator.failure')).toHaveCount(0)
  expect(posts).toBe(1)
})

test('consultation incertaine et fichier manquant supprimable sans arrêter YouTube', async ({ page, request }) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trdl0000004' } })).json()
  let mode = 'network'
  let deletes = 0
  await page.route('**/download', route => {
    if (mode === 'network') return route.abort()
    if (mode === 'missing') return route.fulfill({ status: 409, json: { error: { code: 'local_media_unavailable' }, media_file: file } })
    return route.fulfill({ json: absent })
  })
  await page.route('**/media-files/*', route => { deletes++; mode = 'absent'; return route.fulfill({ status: 204 }) })
  await page.goto(`/videos/${video.id}`)
  await local(page)
  await expect(page.getByRole('button', { name: 'Télécharger le fichier local', exact: true })).toHaveCount(0)
  mode = 'missing'
  await page.getByRole('button', { name: 'Actualiser l’état' }).click()
  await expect(page.getByRole('dialog')).toContainText('Le fichier enregistré est absent')
  await page.getByRole('button', { name: 'Supprimer le fichier local' }).click()
  await page.getByRole('button', { name: 'Confirmer la suppression' }).click()
  await expect.poll(() => deletes).toBe(1)
  await expect(page.getByRole('button', { name: 'Informations', exact: true })).toBeFocused()
  expect(await page.evaluate(() => window.youtubeTest.players[0].pauseCalls)).toBe(0)
  await expect(page.getByRole('button', { name: 'YouTube', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('serveur occupé et suppression refusée restent visibles sans réessai automatique', async ({ page, request }) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trdl0000005' } })).json()
  let status: typeof absent | typeof available = absent
  let posts = 0
  await page.route('**/download', route => {
    if (route.request().method() === 'POST') { posts++; return route.fulfill({ status: 503, json: { error: { code: 'download_busy' } } }) }
    return route.fulfill({ json: status })
  })
  await page.goto(`/videos/${video.id}`)
  await local(page)
  await page.getByRole('button', { name: 'Télécharger le fichier local', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Le média est utilisé')
  expect(posts).toBe(1)
  status = available
  await page.reload()
  await page.route('**/media-files/*', route => route.fulfill({ status: 500, json: { error: { code: 'internal_error' } } }))
  await remove(page)
  await page.getByRole('button', { name: 'Confirmer la suppression' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Une erreur interne empêche cette opération' })).toBeVisible()
  await expect(page.locator('.download-indicator.failure')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Recharger le lecteur local' })).toBeVisible()
})

test('résultats cinq secondes, anciens résultats neutres et erreur consultable', async ({ page, request }) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trdl0000006' } })).json()
  let status: typeof absent | typeof failed = active
  await page.route('**/download', route => route.fulfill({ json: status }))
  await page.goto(`/videos/${video.id}`)
  await expect(page.locator('.download-indicator.progress')).toBeVisible()
  await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') })
  await page.clock.pauseAt(new Date('2030-01-01T00:00:01Z'))
  status = failed
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('.download-indicator.failure')).toBeVisible()
  await page.clock.runFor(4_900)
  await expect(page.locator('.download-indicator.failure')).toBeVisible()
  await page.clock.runFor(200)
  await expect(page.locator('.download-indicator.failure')).toHaveCount(0)
  await expect(page.getByRole('alert')).toContainText('Le téléchargement du média a échoué')
  await page.reload()
  await expect(page.getByRole('button', { name: 'YouTube', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.download-indicator.failure')).toHaveCount(0)
  await local(page)
  await expect(page.getByRole('button', { name: 'Réessayer le téléchargement' })).toBeVisible()
})

test('informations, clavier, consultation partagée et dimensions de barre stables', async ({ page, request }, info) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trdl0000007' } })).json()
  let gets = 0
  await page.route('**/download', route => { gets++; return route.fulfill({ json: available }) })
  await page.goto(`/videos/${video.id}`)
  const toolbar = page.locator('.player-toolbar')
  await expect(page.getByRole('button', { name: 'Local', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const initialGets = gets
  await page.getByRole('button', { name: 'Informations', exact: true }).click()
  const popover = page.getByRole('dialog', { name: 'Informations vidéo' })
  await expect(popover).toBeFocused()
  await expect(popover).toContainText('1080 × 1920')
  await expect(popover).toContainText('29,97 images/s')
  await expect(popover).toContainText('Fichier ajouté le')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Informations', exact: true })).toBeFocused()
  await expect(popover).toHaveCount(0)
  for (const width of [1440, 375, 320]) {
    await page.setViewportSize({ width, height: 900 })
    const group = await toolbar.getByRole('group').boundingBox()
    const eye = await toolbar.getByRole('button', { name: 'Masquer la vidéo' }).boundingBox()
    expect(Math.abs(group!.y - eye!.y)).toBeLessThan(8)
    expect(eye!.x).toBeGreaterThan(group!.x + group!.width)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await toolbar.screenshot({ path: info.outputPath(`toolbar-${width}.png`) })
  }
  await page.getByRole('button', { name: 'Informations', exact: true }).click()
  await page.getByRole('heading', { level: 1 }).click()
  await expect(popover).toHaveCount(0)
  expect(gets).toBe(initialGets)
  await page.getByRole('button', { name: 'YouTube', exact: true }).click()
  await expect(page.getByRole('button', { name: 'YouTube', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Informations', exact: true }).click()
  await expect(popover).toContainText('Source YouTube')
  await expect(popover.getByRole('link', { name: 'Ouvrir la source' })).toHaveAttribute('target', '_blank')
  await local(page)
  await expect(popover).toHaveCount(0)

})

test('une modale ouverte suit les changements serveur sans acquisition concurrente', async ({ page, request }) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trdl0000008' } })).json()
  let status: typeof absent | typeof available = absent
  let posts = 0
  await page.route('**/download', route => {
    if (route.request().method() === 'POST') posts++
    return route.fulfill({ json: status })
  })
  await page.goto(`/videos/${video.id}`)
  await local(page)
  status = active
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('dialog')).toContainText('Téléchargement en cours')
  await expect(page.getByRole('button', { name: 'Télécharger le fichier local', exact: true })).toHaveCount(0)
  status = available
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('dialog')).toContainText('Le fichier local est disponible')
  await expect(page.getByRole('button', { name: 'YouTube', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  await local(page)
  await expect(page.getByRole('button', { name: 'Local', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(posts).toBe(0)
})

test('succès confirmé après POST perdu, durée cinq secondes et largeur constante', async ({ page, request }) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trdl0000009' } })).json()
  let status: typeof absent | typeof available = absent
  let posts = 0
  await page.route('**/download', route => {
    if (route.request().method() === 'POST') { posts++; status = available; return route.abort() }
    return route.fulfill({ json: status })
  })
  await page.goto(`/videos/${video.id}`)
  await local(page)
  await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') })
  await page.clock.pauseAt(new Date('2030-01-01T00:00:01Z'))
  const width = (await page.getByRole('button', { name: 'Local', exact: true }).boundingBox())!.width
  await page.getByRole('button', { name: 'Télécharger le fichier local', exact: true }).click()
  await expect(page.locator('.download-indicator.success')).toBeVisible()
  expect((await page.getByRole('button', { name: 'Local', exact: true }).boundingBox())!.width).toBe(width)
  await page.clock.runFor(4_900)
  await expect(page.locator('.download-indicator.success')).toBeVisible()
  await page.clock.runFor(200)
  await expect(page.locator('.download-indicator.success')).toHaveCount(0)
  expect(posts).toBe(1)
})

test('perte de consultation pendant activité : pas de résultat inventé ni de POST', async ({ page, request }) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trdl0000010' } })).json()
  let broken = false
  let posts = 0
  await page.route('**/download', route => {
    if (route.request().method() === 'POST') posts++
    return broken ? route.abort() : route.fulfill({ json: active })
  })
  await page.goto(`/videos/${video.id}`)
  await expect(page.locator('.download-indicator.progress')).toBeVisible()
  broken = true
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('alert')).toContainText('Impossible')
  await expect(page.locator('.download-indicator.success, .download-indicator.failure')).toHaveCount(0)
  await local(page)
  await expect(page.getByRole('button', { name: 'Actualiser l’état' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Télécharger le fichier local', exact: true })).toHaveCount(0)
  expect(posts).toBe(0)
})

test('métadonnées inconnues des anciens médias sans deuxième consultation', async ({ page, request }) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trdl0000011' } })).json()
  let gets = 0
  await page.route('**/download', route => {
    gets++
    return route.fulfill({ json: { ...available, media_file: { ...file, width: null, height: null, fps: null, video_codec: null, audio_codec: null, audio_language: null } } })
  })
  await page.goto(`/videos/${video.id}`)
  await expect(page.getByRole('button', { name: 'Local', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const count = gets
  await page.getByRole('button', { name: 'Informations', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Informations vidéo' })).toContainText('Inconnues')
  await expect(page.getByRole('dialog', { name: 'Informations vidéo' })).toContainText('Inconnu')
  await page.keyboard.press('Escape')
  await page.getByText('Métadonnées et sources', { exact: true }).click()
  await expect(page.getByRole('region', { name: 'Fichier local', exact: true })).toContainText('Inconnues')
  expect(gets).toBe(count)
})
