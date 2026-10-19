import { test, expect } from './fixtures'

test('recette visuelle : vrai média, informations et barre en clair et sombre', async ({ page, request }, info) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trlpvisual1' } })).json()
  const downloadURL = `/api/v1/videos/${video.id}/sources/${video.sources[0].id}/download`
  await expect.poll(async () => (await request.post(downloadURL)).status()).not.toBe(503)
  await expect.poll(async () => (await (await request.get(downloadURL)).json()).status).toBe('available')
  await request.put(`/api/v1/videos/${video.id}/note`, { data: {
    expected_revision: 0,
    content_md: `# Une connaissance durable

Le lecteur reste un outil de travail : notes et transcription conservent leur place.`,
  } })
  await page.goto('/videos/' + video.id)
  const media = page.locator('video')
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2)
  await media.evaluate((v: HTMLVideoElement) => { v.currentTime = 12 })
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => !v.seeking)).toBe(true)
  await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toContainText('Une connaissance durable')
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState)).toBe(4)
  const panel = page.getByRole('region', { name: 'Lecteur', exact: true })
  for (const width of [1440, 375, 320]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 })
      await page.getByLabel('Thème', { exact: true }).selectOption(theme)
      await expect(panel).toHaveCSS('padding-left', '16px')
      await expect(panel).toHaveCSS('padding-right', '16px')
      await expect(panel).toHaveCSS('padding-bottom', '16px')
      await expect(page.locator('.download-summary')).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: info.outputPath(`local-${width}-${theme}.png`), fullPage: true })
      await page.getByRole('button', { name: 'Informations', exact: true }).click()
      const popover = page.getByRole('dialog', { name: 'Informations vidéo' })
      const bounds = (await popover.boundingBox())!
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
      await page.screenshot({ path: info.outputPath(`informations-${width}-${theme}.png`), fullPage: true })
      await page.keyboard.press('Escape')
    }
  }
})

test('recette visuelle : téléchargement en cours et modale sans interruption', async ({ page, request }, info) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trdlvisual1' } })).json()
  let status = 'not_downloaded'
  await page.route('**/download', route => {
    if (route.request().method() === 'POST') status = 'downloading'
    return route.fulfill({ json: { status, media_file: null, error: null } })
  })
  await page.goto('/videos/' + video.id)
  await page.getByRole('button', { name: 'Local', exact: true }).click()
  await page.getByRole('button', { name: 'Télécharger le fichier local', exact: true }).click()
  await expect(page.locator('.download-indicator.progress')).toBeVisible()
  for (const width of [1440, 375, 320]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 })
      await page.getByLabel('Thème', { exact: true }).selectOption(theme)
      await expect(page.getByRole('button', { name: 'YouTube', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await page.screenshot({ path: info.outputPath(`download-${width}-${theme}.png`), fullPage: true })
      await page.getByRole('button', { name: 'Local', exact: true }).click()
      await page.screenshot({ path: info.outputPath(`dialog-${width}-${theme}.png`), fullPage: true })
      await page.keyboard.press('Escape')
    }
  }
})
