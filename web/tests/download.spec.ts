import { test, expect } from './fixtures'

const file = { id: 17, format: 'mkv', size: 2_000_000, duration_ms: 125_000, added_at: '2026-10-15T12:00:00.000Z', video_codec: 'av1', audio_codec: 'opus', width: 1080, height: 1920, fps: 29.97003, audio_language: 'en-US' }
const absent = { status: 'not_downloaded', media_file: null, error: null }
const active = { status: 'downloading', media_file: null, error: null }
const available = { status: 'available', media_file: file, error: null }

test('téléchargement réel simulé, rechargement et suppression préservent la connaissance', async ({ page, request }) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trdl0000001' } })).json()
  const noteURL = `/api/v1/videos/${video.id}/note`
  const downloadURL = `/api/v1/videos/${video.id}/sources/${video.sources[0].id}/download`
  await request.put(noteURL, { data: { content_md: 'Connaissance durable', expected_revision: 0 } })
  await page.goto(`/videos/${video.id}`)
  await page.getByRole('button', { name: 'Télécharger', exact: true }).click()
  await expect(page.getByText(/Fichier local disponible/)).toBeVisible()
  const downloaded = (await (await request.get(downloadURL)).json()).media_file
  expect(downloaded).toMatchObject({ format: 'mkv', video_codec: 'h264', audio_codec: 'aac',
    width: 640, height: 360, audio_language: 'fr-FR' })
  expect(downloaded.fps).toBeCloseTo(30000 / 1001)
  await page.getByText('Métadonnées et sources', { exact: true }).click()
  const metadata = page.getByRole('region', { name: 'Fichier local', exact: true })
  await expect(metadata).toContainText('640 × 360')
  await expect(metadata).toContainText('fr-FR')
  await expect(metadata).toContainText('29,97 images/s')
  const first = downloaded.id
  await page.reload()
  await expect(page.getByText(/Fichier local disponible/)).toBeVisible()
  expect((await (await request.post(downloadURL)).json()).media_file.id).toBe(first)
  await page.getByRole('button', { name: 'Supprimer le fichier local', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('les notes, les transcriptions et les captures restent conservées')
  await page.getByRole('button', { name: 'Annuler', exact: true }).click()
  expect((await (await request.get(downloadURL)).json()).status).toBe('available')
  await page.getByRole('button', { name: 'Supprimer le fichier local', exact: true }).click()
  await page.getByRole('button', { name: 'Confirmer la suppression' }).click()
  await expect(page.getByRole('button', { name: 'Télécharger', exact: true })).toBeVisible()
  expect((await (await request.get(noteURL)).json()).content_md).toBe('Connaissance durable')
})

test('suivi sans remontage, note en cours, position et lecteur masqué préservés', async ({ page, request }, info) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trdl0000002' } })).json()
  let status: typeof absent | typeof available = absent
  let posts = 0
  await page.route('**/download', route => {
    if (route.request().method() === 'POST') { posts++; status = active }
    return route.fulfill({ status: route.request().method() === 'POST' ? 202 : 200, json: status })
  })
  await page.goto(`/videos/${video.id}`)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  await expect(page.locator('iframe')).toBeVisible()
  const editorNode = await editor.elementHandle()
  const iframeNode = await page.locator('iframe').elementHandle()
  await page.evaluate(() => { const p = window.youtubeTest.players[0]; p.position = 42; p.emitState(2) })
  await editor.fill('Une note en cours')
  await page.getByRole('button', { name: 'Télécharger', exact: true }).click()
  await expect(page.getByText('Téléchargement en cours sur le serveur…')).toBeVisible()
  status = available
  await expect(page.getByText(/Fichier local disponible/)).toBeVisible()
  expect(posts).toBe(1)
  expect(await editorNode!.evaluate(node => node === document.querySelector('.cm-content'))).toBe(true)
  expect(await iframeNode!.evaluate(node => node === document.querySelector('iframe'))).toBe(true)
  expect(await page.evaluate(() => ({
    count: window.youtubeTest.players.length,
    time: window.youtubeTest.players[0].position,
    commands: window.youtubeTest.players[0].navigationCalls.length,
  }))).toEqual({ count: 1, time: 42, commands: 0 })
  await editor.focus()
  await page.keyboard.press('Control+z')
  await expect(editor).toHaveText('')
  await page.keyboard.press('Control+Shift+Z')
  await expect(editor).toHaveText('Une note en cours')
  await page.getByRole('button', { name: 'Masquer le lecteur' }).click()
  await expect(page.getByRole('button', { name: 'Supprimer le fichier local' })).toBeVisible()
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 })
    await page.screenshot({ path: info.outputPath(`download-${width}.png`), fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
})

test('réponse POST perdue relue sans nouvelle acquisition ; état retrouvé après navigation', async ({ page, request }) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trdl0000003' } })).json()
  let status: typeof absent | typeof available = absent
  let posts = 0
  await page.route('**/download', route => {
    if (route.request().method() === 'POST') { posts++; status = active; return route.abort() }
    return route.fulfill({ json: status })
  })
  await page.goto(`/videos/${video.id}`)
  await page.getByRole('button', { name: 'Télécharger', exact: true }).click()
  await expect(page.getByText('Téléchargement en cours sur le serveur…')).toBeVisible()
  await page.getByRole('link', { name: 'Sillage, accueil' }).click()
  await page.goto(`/videos/${video.id}`)
  await expect(page.getByText('Téléchargement en cours sur le serveur…')).toBeVisible()
  expect(posts).toBe(1)
})

test('erreur de consultation distincte, fichier manquant supprimable et échec détaillé', async ({ page, request }) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trdl0000004' } })).json()
  let mode = 'network'
  let deletes = 0
  await page.route('**/download', route => {
    if (mode === 'network') return route.abort()
    if (mode === 'missing') return route.fulfill({ status: 409, json: { error: { code: 'local_media_unavailable' }, media_file: file } })
    return route.fulfill({ json: { status: 'failed', media_file: null, error: { code: 'media_unfinished', message: 'internal' } } })
  })
  await page.route('**/media-files/*', route => { deletes++; mode = 'failed'; return route.fulfill({ status: 204 }) })
  await page.goto(`/videos/${video.id}`)
  await expect(page.getByText('État du fichier local indisponible.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Télécharger', exact: true })).toHaveCount(0)
  mode = 'missing'
  await page.getByRole('button', { name: 'Actualiser l’état' }).click()
  await expect(page.getByText(/Le fichier enregistré est absent/)).toBeVisible()
  await page.getByRole('button', { name: 'Supprimer le fichier local' }).click()
  await page.getByRole('button', { name: 'Confirmer la suppression' }).click()
  await expect(page.getByText(/Cette vidéo n’est pas encore disponible/)).toBeVisible()
  expect(deletes).toBe(1)
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
  await page.getByRole('button', { name: 'Télécharger', exact: true }).click()
  await expect(page.getByText(/Un autre téléchargement occupe le serveur/)).toBeVisible()
  expect(posts).toBe(1)
  status = available
  await page.getByRole('button', { name: 'Actualiser l’état' }).click()
  await page.route('**/media-files/*', route => route.fulfill({ status: 500, json: { error: { code: 'internal_error' } } }))
  await page.getByRole('button', { name: 'Supprimer le fichier local' }).click()
  await page.getByRole('button', { name: 'Confirmer la suppression' }).click()
  await expect(page.getByText(/Une erreur interne empêche cette opération/)).toBeVisible()
})


test('métadonnées locales partagent la consultation et présentent les inconnues des anciens fichiers', async ({ page, request }) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trdl0000006' } })).json()
  let gets = 0
  let legacy = false
  await page.route('**/download', route => {
    gets++
    return route.fulfill({ json: { ...available, media_file: legacy ? {
      ...file, video_codec: null, audio_codec: null, width: null, height: null, fps: null, audio_language: null,
    } : file } })
  })
  await page.goto('/videos/' + video.id)
  await expect(page.getByText(/Fichier local disponible/)).toBeVisible()
  const before = gets
  await page.getByText('Métadonnées et sources', { exact: true }).click()
  const metadata = page.getByRole('region', { name: 'Fichier local', exact: true })
  await expect(metadata).toContainText('1080 × 1920')
  await expect(metadata).toContainText('en-US')
  await expect(metadata).toContainText('av1')
  await expect(metadata).toContainText('opus')
  expect(gets).toBe(before)
  legacy = true
  await page.reload()
  await expect(page.getByText(/Fichier local disponible/)).toBeVisible()
  await page.getByText('Métadonnées et sources', { exact: true }).click()
  await expect(metadata).toContainText('Inconnues')
  await expect(metadata).not.toContainText('1080')
  await expect(metadata).not.toContainText('en-US')
})
