import { expect, test } from './fixtures'

test('note stable, sélection, Undo/Redo et sauvegarde pendant les interactions du workspace', async ({ page, request }, info) => {
  const externalID = `tr10000000${info.retry}`
  const video = await (await request.post('/api/v1/videos', { data: { url: `https://youtu.be/${externalID}` } })).json()
  const noteURL = `/api/v1/videos/${video.id}/note`
  const transcriptURL = `/api/v1/videos/${video.id}/sources/${video.sources[0].id}/transcript`
  const original = '# Titre\r\n\nTexte\r\n'
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
  await page.getByLabel('Thème', { exact: true }).selectOption('dark')
  await expect(page.locator('.markdown-editor')).toHaveCSS('background-color', 'rgb(16, 28, 48)')
  await expect(editor).toHaveCSS('color', 'rgb(224, 232, 245)')
  await page.screenshot({ path: info.outputPath('workspace-dark.png'), fullPage: true })
  await page.getByRole('button', { name: 'Masquer le lecteur' }).click()
  await page.getByLabel('Intervalle').selectOption('30')
  await page.setViewportSize({ width: 375, height: 812 })
  await page.getByRole('button', { name: 'Afficher le lecteur' }).click()
  await page.getByLabel('Thème', { exact: true }).selectOption('light')
  expect(await node!.evaluate(element => element === document.querySelector('.cm-content'))).toBe(true)
  await editor.focus()
  await page.keyboard.type('remplacement')
  await page.keyboard.press('Control+s')
  await expect.poll(async () => (await (await request.get(noteURL)).json()).content_md).toBe(original + 'remplacement')
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+s')
  await expect.poll(async () => (await (await request.get(noteURL)).json()).content_md).toBe(original + 'suite')
  // Une vraie frappe avec Maj produit « Z » ; « z » simulerait un événement incohérent.
  await page.keyboard.press('Control+Shift+Z')
  await page.keyboard.press('Control+s')
  await expect.poll(async () => (await (await request.get(noteURL)).json()).content_md).toBe(original + 'remplacement')
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
  const note = page.locator('.workspace-note')
  const text = page.getByLabel('Texte de la transcription')
  const before = await text.boundingBox()
  expect(await note.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  expect(await text.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  await text.evaluate(element => { element.scrollTop = 150 })
  expect(await note.evaluate(element => element.scrollTop)).toBe(0)
  await page.screenshot({ path: info.outputPath('workspace-desktop.png') })
  await page.getByRole('button', { name: 'Masquer le lecteur' }).click()
  const after = await text.boundingBox()
  expect(after!.height).toBeGreaterThan(before!.height + 150)
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 812 })
    await page.getByRole('button', { name: 'Afficher le lecteur' }).click()
    const player = await page.locator('.video-player').boundingBox()
    const editor = await note.boundingBox()
    const transcript = await page.locator('.video-transcript').boundingBox()
    expect(player!.y + player!.height).toBeLessThanOrEqual(editor!.y)
    expect(editor!.y + editor!.height).toBeLessThanOrEqual(transcript!.y)
    expect((await page.locator('.youtube-frame iframe').boundingBox())!.height).toBeGreaterThanOrEqual(200)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: info.outputPath(`workspace-${width}.png`) })
    await page.getByRole('button', { name: 'Masquer le lecteur' }).click()
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
  await expect(page.locator('.work-source')).toContainText('Source retenue · ABCDEFGHIJK')
  await expect(page.locator('iframe')).toHaveAttribute('title', 'Lecteur YouTube : Source retenue')
  expect(requested.every(url => url.endsWith('/sources/9/transcript'))).toBe(true)
  sources.splice(2)
  await page.reload()
  await expect(page.getByText('Aucune source YouTube exploitable', { exact: false })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toBeVisible()
  await expect(page.locator('iframe')).toHaveCount(0)
})
