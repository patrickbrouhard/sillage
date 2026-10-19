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
  await page.getByRole('button', { name: 'Local', exact: true }).click()
  await page.getByRole('button', { name: 'Télécharger le fichier local', exact: true }).click()
  await expect(page.locator('.download-summary')).toContainText('MKV ·')
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
  await page.getByRole('button', { name: 'Local', exact: true }).click()
  await expect(page.locator('.download-summary')).toContainText('MKV ·')
  expect((await (await request.post(downloadURL)).json()).media_file.id).toBe(first)
  await page.getByRole('button', { name: 'Supprimer le fichier local', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('les notes, les transcriptions et les captures restent conservées')
  await page.getByRole('button', { name: 'Annuler', exact: true }).click()
  expect((await (await request.get(downloadURL)).json()).status).toBe('available')
  await page.getByRole('button', { name: 'Supprimer le fichier local', exact: true }).click()
  await page.getByRole('button', { name: 'Confirmer la suppression' }).click()
  await expect(page.getByRole('button', { name: 'Télécharger le fichier local', exact: true })).toBeVisible()
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
  await page.getByRole('button', { name: 'Local', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()

  const editorNode = await editor.elementHandle()


  await editor.fill('Une note en cours')
  await page.getByRole('button', { name: 'Télécharger le fichier local', exact: true }).click()
  await expect(page.getByText('Téléchargement en cours sur le serveur…')).toBeVisible()
  status = available
  await expect(page.locator('.download-summary')).toContainText('MKV ·')
  expect(posts).toBe(1)
  expect(await editorNode!.evaluate(node => node === document.querySelector('.cm-content'))).toBe(true)
  await expect(page.getByLabel('Mode de lecture').getByRole('button', { name: 'Local', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await editor.focus()
  await page.keyboard.press('Control+z')
  await expect(editor).toHaveText('')
  await page.keyboard.press('Control+Shift+Z')
  await expect(editor).toHaveText('Une note en cours')
  await page.getByRole('button', { name: 'Masquer la vidéo' }).click()
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
  await page.getByRole('button', { name: 'Local', exact: true }).click()
  await page.getByRole('button', { name: 'Télécharger le fichier local', exact: true }).click()
  await expect(page.getByText('Téléchargement en cours sur le serveur…')).toBeVisible()
  await page.getByRole('link', { name: 'Sillage, accueil' }).click()
  await page.goto(`/videos/${video.id}`)
  await page.getByRole('button', { name: 'Local', exact: true }).click()
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
  await page.getByRole('button', { name: 'Local', exact: true }).click()
  await expect(page.getByText('État du fichier local indisponible.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Télécharger le fichier local', exact: true })).toHaveCount(0)
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
  await page.getByRole('button', { name: 'Local', exact: true }).click()
  await page.getByRole('button', { name: 'Télécharger le fichier local', exact: true }).click()
  await expect(page.getByText(/Le média est utilisé ou un téléchargement occupe le serveur/)).toBeVisible()
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
  await page.getByRole('button', { name: 'Local', exact: true }).click()
  await expect(page.locator('.download-summary')).toContainText('MKV ·')
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
  await page.getByRole('button', { name: 'Local', exact: true }).click()
  await expect(page.locator('.download-summary')).toContainText('MKV ·')
  await page.getByText('Métadonnées et sources', { exact: true }).click()
  await expect(metadata).toContainText('Inconnues')
  await expect(metadata).not.toContainText('1080')
  await expect(metadata).not.toContainText('en-US')
})


test('barre unique : informations, commandes, responsive et focus après annulation', async ({ page, request }, info) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trdl0000007' } })).json()
  let status: typeof absent | typeof available = absent
  await page.route('**/download', route => route.fulfill({ json: status }))
  await page.goto(`/videos/${video.id}`)
  await page.getByRole('button', { name: 'Local', exact: true }).click()
  const toolbar = page.locator('.player-toolbar')
  const title = toolbar.getByLabel('Mode de lecture')
  const eye = toolbar.getByRole('button', { name: 'Masquer la vidéo' })
  await expect(toolbar.getByRole('button', { name: 'Télécharger le fichier local' })).toBeVisible()
  await expect(page.locator('.download-summary')).toBeEmpty()
  await expect(page.locator('.video-download')).toHaveCSS('border-top-width', '0px')
  status = available
  // Une relecture explicite de page simule ici une acquisition terminée hors de cette session.
  await page.reload()
  await page.getByRole('button', { name: 'Local', exact: true }).click()
  await expect(toolbar.getByRole('button', { name: 'Supprimer le fichier local', exact: true })).toBeVisible()
  await expect(page.locator('.download-summary')).toHaveText('MKV · 1,9 Mio · 2:05')
  await expect(toolbar.getByRole('button', { name: 'Télécharger le fichier local' })).toHaveCount(0)
  for (const width of [1440, 375, 320]) {
    await page.setViewportSize({ width, height: 900 })
    const heading = await title.boundingBox()
    const visibility = await eye.boundingBox()
    expect(Math.abs(heading!.y - visibility!.y)).toBeLessThan(12)
    expect(visibility!.x).toBeGreaterThan(heading!.x + heading!.width)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await toolbar.screenshot({ path: info.outputPath(`player-toolbar-${width}.png`) })
  }
  const trash = toolbar.getByRole('button', { name: 'Supprimer le fichier local', exact: true })
  await trash.click()
  await expect(page.getByRole('button', { name: 'Annuler', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Annuler', exact: true }).click()
  await expect(trash).toBeFocused()
  await page.mouse.move(0, 0)
  await expect(page.locator('.icon-tooltip:visible')).toHaveCount(0)
})
