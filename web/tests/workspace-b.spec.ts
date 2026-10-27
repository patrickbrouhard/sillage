import { test, expect } from './fixtures'

test('panneau droit jointif, texte minimal et défilement de page avec recherche et erreurs', async ({ page, request }, info) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trBminimum1' } })).json()
  await request.put('/api/v1/videos/' + video.id + '/note', { data: {
    expected_revision: 0, content_md: 'Une note conservée\n'.repeat(200),
  } })
  await page.route('**/transcript', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 500, json: { error: { code: 'internal_error' } } })
    : route.fulfill({ json: {
      language: 'fr', provenance: 'youtube_auto', last_fetched_at: '2026-10-12T10:00:00Z',
      items: Array.from({ length: 100 }, (_, i) => ({ start_ms: i * 10000, text: 'Un passage à rechercher ' + i })),
    } }))
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/videos/' + video.id)
  const text = page.getByLabel('Texte de la transcription')
  const player = page.locator('.video-player')
  const transcript = page.locator('.video-transcript')
  const frame = page.locator('.youtube-frame iframe')
  await expect(frame).toBeVisible()
  await expect(text).toContainText('Un passage')
  const editor = await page.getByRole('textbox', { name: 'Note Markdown' }).elementHandle()
  const instance = await frame.elementHandle()
  await page.locator('.transcript-actions').getByRole('button', { name: 'Rechercher dans la transcription', exact: true }).click()
  await page.getByRole('searchbox').fill('passage')
  await page.getByRole('button', { name: 'Actualiser la transcription', exact: true }).click()
  await expect(transcript.getByRole('alert')).toBeVisible()
  for (const [width, height] of [[1920, 1080], [1920, 800], [1440, 600], [1100, 500]]) {
    await page.setViewportSize({ width, height })
    const p = (await player.boundingBox())!
    const t = (await transcript.boundingBox())!
    const v = (await frame.boundingBox())!
    const content = (await text.boundingBox())!
    expect(t.y).toBeCloseTo(p.y + p.height, 1)
    expect(t.x).toBeCloseTo(p.x, 1)
    expect(t.width).toBeCloseTo(p.width, 1)
    expect(content.height).toBeGreaterThanOrEqual(192)
    expect(v.height).toBeCloseTo(v.width * 9 / 16, 1)
    await expect(player).toHaveCSS('border-bottom-width', '0px')
    await expect(transcript).toHaveCSS('border-top-width', '0px')
    await expect(transcript).toHaveCSS('overflow', 'visible')
    expect(await text.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
    if (height <= 800) expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(true)
    const note = (await page.locator('.workspace-note').boundingBox())!
    expect(note.y + note.height).toBeCloseTo(t.y + t.height, 1)
    await page.screenshot({ path: info.outputPath('unified-' + width + '-' + height + '.png'), fullPage: true })
  }
  await page.setViewportSize({ width: 1920, height: 1080 })
  const before = (await text.boundingBox())!.height
  await page.getByRole('button', { name: 'Masquer la vidéo' }).click()
  await expect(frame).toBeHidden()
  expect((await text.boundingBox())!.height).toBeGreaterThan(before + 350)
  await page.getByRole('button', { name: 'Informations', exact: true }).click()
  const popup = page.getByRole('dialog', { name: 'Informations vidéo' })
  await expect(popup).toBeVisible()
  const popupBox = (await popup.boundingBox())!
  expect(popupBox.y).toBeCloseTo((await player.boundingBox())!.y + (await page.locator('.player-toolbar').boundingBox())!.height + 1, 1)
  await popup.getByRole('button', { name: 'Fermer les informations' }).click()
  await page.getByRole('button', { name: 'Afficher la vidéo' }).click()
  expect(await instance!.evaluate(el => el === document.querySelector('.youtube-frame iframe'))).toBe(true)
  expect(await editor!.evaluate(el => el === document.querySelector('.cm-content'))).toBe(true)
})

test('message informatif sous la vidéo sans déplacement de la surface', async ({ page, request }) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trBmessage1' } })).json()
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/videos/' + video.id)
  const frame = page.locator('.youtube-frame iframe')
  await expect(frame).toBeVisible()
  const before = await frame.boundingBox()
  await page.evaluate(() => {
    const player = window.youtubeTest.players.at(-1)!
    player.options.events.onAutoplayBlocked({ target: player })
  })
  const message = page.getByText('Le navigateur a bloqué le démarrage. Utilisez le bouton Lecture du lecteur.')
  await expect(message).toBeVisible()
  expect(await frame.boundingBox()).toEqual(before)
  expect((await message.boundingBox())!.y).toBeGreaterThanOrEqual(before!.y + before!.height)
})
