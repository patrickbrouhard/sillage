import { selectTheme } from './navigationHelpers'
import type { Locator } from '@playwright/test'
import { test, expect } from './fixtures'

test('recette visuelle : vrai média, informations et barre en clair et sombre', async ({ page, request }, info) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trlpvisual1' } })).json()
  const downloadURL = `/api/v1/videos/${video.id}/sources/${video.sources[0].id}/download`
  await expect.poll(async () => (await request.post(downloadURL)).status(), { timeout: 15_000 }).not.toBe(503)
  await expect.poll(async () => (await (await request.get(downloadURL)).json()).status).toBe('available')
  await request.put(`/api/v1/videos/${video.id}/note`, { data: {
    expected_revision: 0,
    content_md: `# Une connaissance durable

Le lecteur reste un outil de travail : notes et transcription conservent leur place.`,
  } })
  await page.goto('/videos/' + video.id)
  const media = page.locator('video')
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState)).toBe(4)
  await media.evaluate((v: HTMLVideoElement) => { v.currentTime = 12 })
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => !v.seeking)).toBe(true)
  await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toContainText('Une connaissance durable')
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState)).toBe(4)
  const panel = page.getByRole('region', { name: 'Lecteur', exact: true })
  for (const width of [1440, 375, 320]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 })
      await selectTheme(page, theme)
      await expect(panel).toHaveCSS('padding-left', '16px')
      await expect(panel).toHaveCSS('padding-right', '16px')
      await expect(panel).toHaveCSS('padding-bottom', '0px')
      await checkEdges(panel, media)
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
      await page.getByRole('button', { name: 'YouTube', exact: true }).click()
      const iframe = page.locator('.youtube-frame iframe')
      await expect(iframe).toBeVisible()
      await checkEdges(panel, iframe)
      await page.screenshot({ path: info.outputPath(`youtube-${width}-${theme}.png`), fullPage: true })
      await page.getByRole('button', { name: 'Masquer la vidéo' }).click()
      await expect(iframe).toBeHidden()
      await expect(panel).toHaveCSS('padding-bottom', '16px')
      await page.getByRole('button', { name: 'Informations', exact: true }).click()
      await expect(popover).toBeVisible()
      // Le popover dépasse volontairement un panneau masqué ; aucun ancêtre ne le découpe.
      await expect(panel).toHaveCSS('overflow', 'visible')
      const close = popover.getByRole('button', { name: 'Fermer les informations' })
      await expect(close).toBeVisible()
      await page.screenshot({ path: info.outputPath(`hidden-info-${width}-${theme}.png`), fullPage: true })
      await close.click()
      await page.getByRole('button', { name: 'Afficher la vidéo' }).click()
      await page.getByRole('button', { name: 'Local', exact: true }).click()
      await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState)).toBe(4)
    }
  }
  // Les états exceptionnels gardent leurs textes dans la zone rembourrée.
  await media.evaluate(v => v.dispatchEvent(new Event('error')))
  await expect(page.getByText(/Impossible de lire ce fichier local/)).toBeVisible()
  for (const state of ['error', 'empty']) {
    if (state === 'empty') {
      await page.getByRole('button', { name: 'Informations', exact: true }).click()
      await page.getByRole('button', { name: 'Supprimer le fichier local', exact: true }).click()
      await page.getByRole('button', { name: 'Confirmer la suppression' }).click()
      await expect(page.getByText(/Aucun fichier local. Téléchargez/)).toBeVisible()
      await expect(media).toHaveCount(0)
      await expect(panel).toHaveCSS('padding-bottom', '16px')
    }
    for (const width of [1440, 375, 320]) {
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 900 })
        await selectTheme(page, theme)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        const text = state === 'error' ? page.getByText(/Impossible de lire ce fichier local/) : page.locator('.local-empty')
        const bounds = (await text.boundingBox())!
        const frame = (await panel.boundingBox())!
        expect(bounds.x).toBeGreaterThanOrEqual(frame.x + 16)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(frame.x + frame.width - 16)
        await page.screenshot({ path: info.outputPath(`${state}-${width}-${theme}.png`), fullPage: true })
      }
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
      await selectTheme(page, theme)
      await expect(page.getByRole('button', { name: 'YouTube', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await page.screenshot({ path: info.outputPath(`download-${width}-${theme}.png`), fullPage: true })
      await page.getByRole('button', { name: 'Local', exact: true }).click()
      await page.screenshot({ path: info.outputPath(`dialog-${width}-${theme}.png`), fullPage: true })
      await page.keyboard.press('Escape')
    }
  }
})

/** Vérifie les bords réels sans imposer une nouvelle règle de hauteur. */
async function checkEdges(panel: Locator, surface: Locator) {
  const p = (await panel.boundingBox())!
  const v = (await surface.boundingBox())!
  // Les deux surfaces suivent la largeur, avec le minimum mobile commun de 200 px.
  expect(v.height).toBeCloseTo(Math.max(200, v.width * 9 / 16), 1)
  expect(v.x).toBeCloseTo(p.x + 1, 1)
  expect(v.x + v.width).toBeCloseTo(p.x + p.width - 1, 1)
  expect(v.y + v.height).toBeCloseTo(p.y + p.height - 1, 1)
  const rounded = surface.locator('..')
  if (await surface.evaluate(n => n.tagName === 'VIDEO')) {
    await expect(surface).toHaveCSS('border-bottom-left-radius', '11px')
  } else {
    await expect(rounded).toHaveCSS('border-bottom-left-radius', '11px')
    await expect(rounded).toHaveCSS('overflow', 'hidden')
  }
}
