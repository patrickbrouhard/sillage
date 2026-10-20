import { expect, test } from './fixtures'

test('note stable, sélection, Undo/Redo et sauvegarde pendant les interactions du workspace', async ({ page, request }, info) => {
  const externalID = `tr10000000${info.retry}`
  const video = await (await request.post('/api/v1/videos', { data: { url: `https://youtu.be/${externalID}` } })).json()
  const noteURL = `/api/v1/videos/${video.id}/note`
  const transcriptURL = `/api/v1/videos/${video.id}/sources/${video.sources[0].id}/transcript`
  const original = '# Titre\r\n\nTexte\r\n'
  const canonical = '# Titre\n\nTexte\n'
  await request.put(noteURL, { data: { content_md: original, expected_revision: 0 } })
  await request.post(transcriptURL)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`/videos/${video.id}`)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  const node = await editor.elementHandle()
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('suite')
  await page.keyboard.press('Shift+Home')
  const information = page.getByRole('tab', { name: 'Informations', exact: true })
  const noteTab = page.getByRole('tab', { name: 'Note', exact: true })
  await information.click()
  await expect(editor).toBeHidden()
  await expect(page.getByRole('button', { name: /tags/ })).toBeVisible()
  // L'autosauvegarde continue malgré la disparition visuelle de l'éditeur.
  await expect.poll(async () => (await (await request.get(noteURL)).json()).content_md).toBe(canonical + 'suite')
  await information.press('Home')
  await expect(noteTab).toBeFocused()
  await expect(noteTab).toHaveAttribute('aria-selected', 'true')
  await noteTab.press('ArrowLeft')
  await expect(information).toBeFocused()
  await information.press('ArrowRight')
  await expect(noteTab).toBeFocused()
  await noteTab.press('End')
  await expect(information).toBeFocused()
  await information.press('Home')
  await expect(editor).toBeVisible()
  await page.getByLabel('Thème', { exact: true }).selectOption('dark')
  await expect(page.locator('.markdown-editor')).toHaveCSS('background-color', 'rgb(16, 28, 48)')
  await expect(editor).toHaveCSS('color', 'rgb(224, 232, 245)')
  await page.screenshot({ path: info.outputPath('workspace-dark.png'), fullPage: true })
  await page.getByRole('button', { name: 'Masquer la vidéo' }).click()
  await page.getByRole('button', { name: 'Rechercher dans la transcription', exact: true }).click()
  await page.getByRole('searchbox').fill('Bonjour')
  await page.setViewportSize({ width: 375, height: 812 })
  await page.getByRole('button', { name: /Aller à .* dans le lecteur/ }).first().click()
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await page.getByLabel('Thème', { exact: true }).selectOption('light')
  expect(await node!.evaluate(element => element === document.querySelector('.cm-content'))).toBe(true)
  await editor.focus()
  await page.keyboard.type('remplacement')
  await page.keyboard.press('Control+s')
  await expect.poll(async () => (await (await request.get(noteURL)).json()).content_md).toBe(canonical + 'remplacement')
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+s')
  await expect.poll(async () => (await (await request.get(noteURL)).json()).content_md).toBe(canonical + 'suite')
  // Une vraie frappe avec Maj produit « Z » ; « z » simulerait un événement incohérent.
  await page.keyboard.press('Control+Shift+Z')
  await page.keyboard.press('Control+s')
  await expect.poll(async () => (await (await request.get(noteURL)).json()).content_md).toBe(canonical + 'remplacement')
})

test('défilements indépendants, espace libéré et ordre mobile sans remontage', async ({ page, request }, info) => {
  const externalID = `tr20000000${info.retry}`
  const video = await (await request.post('/api/v1/videos', { data: { url: `https://youtu.be/${externalID}` } })).json()
  await request.put(`/api/v1/videos/${video.id}/note`, { data: {
    content_md: 'Une longue note\n'.repeat(200), expected_revision: 0,
  } })
  await page.route('**/transcript', route => route.fulfill({ json: {
    language: 'fr', provenance: 'youtube_auto', last_fetched_at: '2026-10-12T10:00:00Z',
    items: Array.from({ length: 180 }, (_, i) => ({ start_ms: i * 10000, text: `Passage ${i}.\n` })),
  } }))
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`/videos/${video.id}`)
  await expect(page.locator('.transcript-block')).toHaveCount(180)
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toContainText('Une longue note')
  const note = page.locator('#note-panel')
  const text = page.getByLabel('Texte de la transcription')
  const before = await text.boundingBox()
  expect(await note.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  expect(await text.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  await text.evaluate(element => { element.scrollTop = 150 })
  expect(await note.evaluate(element => element.scrollTop)).toBe(0)
  await page.screenshot({ path: info.outputPath('workspace-desktop.png') })
  await page.getByRole('button', { name: 'Masquer la vidéo' }).click()
  const after = await text.boundingBox()
  expect(after!.height).toBeGreaterThan(before!.height + 150)
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 812 })
    await page.getByRole('button', { name: 'Afficher la vidéo' }).click()
    const player = await page.locator('.video-player').boundingBox()
    const editor = await page.locator('.workspace-note').boundingBox()
    const transcript = await page.locator('.video-transcript').boundingBox()
    expect(player!.y + player!.height).toBeLessThanOrEqual(editor!.y)
    expect(editor!.y + editor!.height).toBeLessThanOrEqual(transcript!.y)
    expect((await page.locator('.youtube-frame iframe').boundingBox())!.height).toBeGreaterThanOrEqual(200)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: info.outputPath(`workspace-${width}.png`) })
    await page.getByRole('button', { name: 'Masquer la vidéo' }).click()
  }
})

test('source commune dans l’ordre REST et absence compatible sans bloquer la note', async ({ page }) => {
  const sources = [
    { id: 1, provider: 'local', external_id: 'abcdefghijk', title: 'Source locale' },
    { id: 2, provider: 'youtube', external_id: null, title: 'Source incomplète' },
    { id: 9, provider: 'youtube', external_id: 'ABCDEFGHIJK', title: 'Source retenue' },
    { id: 3, provider: 'youtube', external_id: 'abcdefghijk', title: 'Autre source' },
  ]
  await page.route('**/api/v1/videos/42', route => route.fulfill({ json: {
    id: 42, created_at: '2026-10-12', tags: [], person_ids: [], sources,
  } }))
  await page.route('**/note', route => route.fulfill({ status: 404, json: { error: { code: 'note_not_found' } } }))
  const requested: string[] = []
  await page.route('**/transcript', route => {
    requested.push(route.request().url())
    return route.fulfill({ status: 404, json: { error: { code: 'transcript_not_found' } } })
  })
  await page.goto('/videos/42')
  await expect(page.getByRole('group', { name: 'Mode de lecture' })).toContainText('YouTube')
  await page.getByRole('tab', { name: 'Informations', exact: true }).click()
  const workingSource = page.locator('.source-section').filter({ hasText: 'Source de travail du lecteur et de la transcription' })
  await expect(workingSource).toContainText('Source retenue')
  await expect(workingSource).toContainText('ABCDEFGHIJK')
  await expect(page.locator('iframe')).toHaveAttribute('title', 'Lecteur YouTube : Source retenue')
  expect(requested.every(url => url.endsWith('/sources/9/transcript'))).toBe(true)
  sources.splice(2)
  await page.reload()
  await expect(page.getByText('Aucune source YouTube exploitable', { exact: false })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toBeVisible()
  await expect(page.locator('iframe')).toHaveCount(0)
})

test('onglets : défilement, mode Lecture et absence d’écriture conservés', async ({ page, request }) => {
  const video = await (await request.post('/api/v1/videos', {
    data: { url: 'https://youtu.be/trTabsScroll' },
  })).json()
  await request.put('/api/v1/videos/' + video.id + '/note', {
    data: { content_md: 'Paragraphe long.\n\n'.repeat(150), expected_revision: 0 },
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/videos/' + video.id)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  const node = await editor.elementHandle()
  let writes = 0
  page.on('request', request => {
    if (request.method() === 'PUT' && request.url().endsWith('/note')) writes++
  })
  const panel = page.locator('#note-panel')
  await panel.evaluate(element => { element.scrollTop = 400 })
  const scroll = await panel.evaluate(element => element.scrollTop)
  await page.getByRole('tab', { name: 'Informations', exact: true }).click()
  await page.getByRole('tabpanel', { name: 'Informations', exact: true }).evaluate(element => { element.scrollTop = 150 })
  await page.getByRole('tab', { name: 'Note', exact: true }).click()
  await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBe(scroll)
  expect(await node!.evaluate(element => element === document.querySelector('.cm-content'))).toBe(true)
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await expect(page.locator('.markdown-reading')).toBeVisible()
  await page.getByRole('tab', { name: 'Informations', exact: true }).click()
  await page.getByRole('tab', { name: 'Note', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(editor).toBeHidden()
  await page.getByRole('button', { name: 'Édition', exact: true }).click()
  expect(await node!.evaluate(element => element === document.querySelector('.cm-content'))).toBe(true)
  expect(writes).toBe(0)
})

for (const failure of ['conflict', 'error']) {
  test('Informations conserve les protections de note : ' + failure, async ({ page, request }) => {
    const video = await (await request.post('/api/v1/videos', {
      data: { url: 'https://youtu.be/trTabs' + failure },
    })).json()
    const noteURL = '/api/v1/videos/' + video.id + '/note'
    await request.put(noteURL, { data: { content_md: 'Initial', expected_revision: 0 } })
    await page.goto('/videos/' + video.id)
    const editor = page.getByRole('textbox', { name: 'Note Markdown' })
    await editor.fill('Texte local')
    if (failure === 'conflict') {
      await request.put(noteURL, { data: { content_md: 'Texte distant', expected_revision: 1 } })
    } else {
      await page.route('**' + noteURL, route => route.request().method() === 'PUT'
        ? route.fulfill({ status: 400, json: { error: { code: 'bad_request' } } })
        : route.continue())
    }
    await page.getByRole('tab', { name: 'Informations', exact: true }).click()
    await page.keyboard.press('Control+s')
    await expect(page.locator('.note-hidden-error')).toBeVisible()
    await page.getByRole('link', { name: 'Sillage, accueil' }).click()
    const dialog = page.getByRole('dialog', { name: 'Quitter la note ?' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Rester sur la note' }).click()
    await expect(page.getByRole('tab', { name: 'Informations', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('button', { name: 'Revenir à la note' }).click()
    await expect(editor).toHaveText('Texte local')
    if (failure === 'conflict') await expect(page.getByRole('region', { name: 'Résolution du conflit' })).toBeVisible()
  })
}
