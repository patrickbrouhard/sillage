import type { APIRequestContext, Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { test, expect } from './fixtures'
import type { Asset } from '../src/assetApi'

// Un PNG plein format texturé exerce les transferts et le décodage, pas seulement le CSS.
const png = execFileSync('/usr/bin/ffmpeg', [
  '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080,noise=alls=12:allf=t',
  '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
], { maxBuffer: 16 * 1024 * 1024 })

/** Contrôle le catalogue seulement ; la note et ses révisions traversent le serveur réel. */
async function setup(page: Page, request: APIRequestContext, content = 'alpha omega') {
  const externalID = 'trlp' + test.info().testId.slice(-7)
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/' + externalID } })).json()
  const noteURL = `/api/v1/videos/${video.id}/note`
  await request.put(noteURL, { data: { content_md: content, expected_revision: 0 } })
  const assets: Asset[] = Array.from({ length: 14 }, (_, i) => ({
    id: 800 + i, video_id: video.id, source_id: video.sources[0].id, timestamp_ms: i * 1000,
    type: 'screenshot', status: 'available', error_code: '', created_at: '2026-10-25T12:00:00Z',
  }))
  let lists = 0, writes = 0, creations = 0, individual = 0, contents = 0
  page.on('request', r => {
    if (r.method() === 'PUT' && r.url().endsWith('/note')) writes++
    if (r.method() === 'POST' && r.url().endsWith('/captures')) creations++
    if (/\/assets\/\d+$/.test(r.url())) individual++
  })
  await page.route(`**/api/v1/videos/${video.id}/assets?*`, async route => {
    lists++
    const current = Number(new URL(route.request().url()).searchParams.get('page'))
    await route.fulfill({ json: { assets: assets.slice((current - 1) * 12, current * 12), page: current, has_more: current * 12 < assets.length } })
  })
  await page.route('**/api/v1/assets/*/content', async route => {
    contents++
    await route.fulfill({ contentType: 'image/png', body: png })
  })
  await page.goto('/videos/' + video.id)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  const images = page.getByRole('button', { name: 'Images', exact: true })
  const panel = page.getByRole('dialog', { name: 'Images', exact: true })
  return { video, assets, noteURL, editor, images, panel, counts: () => ({ lists, writes, creations, individual, contents }) }
}

test('catalogue borné plein format, consultation sans écriture, pause YouTube et focus non modal', async ({ page, request }) => {
  const c = await setup(page, request)
  const bounds = await c.editor.boundingBox()
  await page.evaluate(() => { const p = window.youtubeTest.players.at(-1)!; p.position = 42; p.emitState(1) })
  await c.images.click()
  await expect(c.panel).toBeVisible()
  await expect(c.panel).not.toHaveAttribute('aria-modal', 'true')
  await expect(page.locator('.image-card')).toHaveCount(12)
  expect(await c.editor.boundingBox()).toEqual(bounds)
  expect(await page.locator('.video-player').getAttribute('inert')).not.toBeNull()
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.state)).toBe(2)
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.destroyed)).toBe(false)
  await c.editor.click()
  await expect(c.panel).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(c.panel).toHaveCount(0)
  await expect(c.editor).toBeFocused()
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.state)).toBe(2)
  expect(c.counts().writes).toBe(0)
  expect(c.counts().creations).toBe(0)
  expect(c.counts().individual).toBe(0)
  expect(c.counts().contents).toBeLessThanOrEqual(12)
  expect(png.length).toBeGreaterThan(1000000)
})

test('pages et agrandissement conservent la grille, Échap ferme une seule surface', async ({ page, request }) => {
  const c = await setup(page, request)
  await c.images.click()
  await expect(page.locator('.image-card')).toHaveCount(12)
  await page.locator('.images-scroll').evaluate(el => { el.scrollTop = 150 })
  const thumbnail = page.getByRole('button', { name: 'Agrandir la capture à 0:03, YouTube', exact: true })
  await thumbnail.click()
  const scroll = await page.locator('.images-scroll').evaluate(el => el.scrollTop)
  await expect(page.getByRole('dialog', { name: 'Agrandissement de l’image' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(c.panel).toBeVisible()
  await expect(thumbnail).toBeFocused()
  expect(await page.locator('.images-scroll').evaluate(el => el.scrollTop)).toBe(scroll)
  await c.panel.getByRole('button', { name: 'Suivant', exact: true }).click()
  await expect(page.locator('.image-card')).toHaveCount(2)
  await expect(c.panel.getByText('Page 2', { exact: true })).toBeVisible()
  await expect(c.panel.getByRole('button', { name: 'Suivant', exact: true })).toBeDisabled()
  await page.screenshot({ path: test.info().outputPath('images-desktop.png') })
  await page.keyboard.press('Escape')
  await expect(c.images).toBeFocused()
  expect(c.counts().writes).toBe(0)
})

test('pending, failed et PNG indisponible restent distincts et réessayables', async ({ page, request }) => {
  const c = await setup(page, request)
  c.assets.splice(3)
  c.assets[0].status = 'pending'
  c.assets[1].status = 'failed'
  await page.route('**/api/v1/assets/802/content', route => route.fulfill({ status: 409 }))
  await c.images.click()
  await expect(c.panel.getByText('Capture en cours de génération…')).toBeVisible()
  await expect(c.panel.getByText('La génération de cette capture a échoué ou a été interrompue.')).toBeVisible()
  await expect(c.panel.getByText('Image indisponible.', { exact: false })).toBeVisible()
  await page.unroute('**/api/v1/assets/802/content')
  await c.panel.getByRole('button', { name: 'Réessayer l’affichage' }).click()
  await expect(c.panel.locator('img')).toHaveCount(1)
  c.assets[0].status = 'available'
  await expect(c.panel.locator('img')).toHaveCount(2)
  const count = c.counts().lists
  await page.waitForTimeout(2200)
  expect(c.counts().lists).toBe(count)
  expect(c.counts().individual).toBe(0)
  expect(c.counts().creations).toBe(0)
})

test('échec catalogue puis liste vide, sans création de note ou capture', async ({ page, request }) => {
  const c = await setup(page, request)
  await page.route(`**/api/v1/videos/${c.video.id}/assets?*`, route => route.fulfill({ status: 500 }))
  await c.images.click()
  await expect(c.panel.getByRole('alert')).toContainText('Impossible de consulter les images')
  await page.unroute(`**/api/v1/videos/${c.video.id}/assets?*`)
  c.assets.splice(0)
  await page.route(`**/api/v1/videos/${c.video.id}/assets?*`, route => route.fulfill({ json: { assets: [], page: 1, has_more: false } }))
  await c.panel.getByRole('button', { name: 'Réessayer le catalogue' }).click()
  await expect(c.panel.getByRole('status')).toHaveText('Aucune capture pour cette vidéo.')
  expect(c.counts().writes).toBe(0)
})

test('responsive conserve éditeur et catalogue et applique une modalité réelle', async ({ page, request }) => {
  const c = await setup(page, request)
  await c.editor.click()
  await page.keyboard.press('Control+End')
  await c.images.click()
  await expect(page.locator('.image-card')).toHaveCount(12)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(c.panel).toHaveAttribute('aria-modal', 'true')
  expect(await c.panel.evaluate(el => el.matches(':modal'))).toBe(true)
  expect(await c.panel.boundingBox()).toMatchObject({ x: 0, y: 0, height: 844 })
  await page.screenshot({ path: test.info().outputPath('images-mobile.png') })
  await page.keyboard.press('Escape')
  await expect(c.images).toBeFocused()
  await c.editor.focus()
  await page.keyboard.type(' suite')
  await expect(c.editor).toHaveText('alpha omega suite')
})

test('pause non confirmée refuse Images sans destruction ni perte du choix masqué', async ({ page, request }) => {
  const c = await setup(page, request)
  await page.evaluate(() => { window.youtubeTest.confirmPause = false; window.youtubeTest.players.at(-1)!.emitState(1) })
  await c.images.click()
  await expect(page.getByRole('alert')).toContainText('pause YouTube n’a pas été confirmée')
  await expect(c.panel).toHaveCount(0)
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.destroyed)).toBe(false)
  await page.evaluate(() => { window.youtubeTest.confirmPause = true })
  await page.getByRole('button', { name: 'Masquer la vidéo', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Afficher la vidéo', exact: true })).toBeVisible()
  await c.images.click()
  await c.panel.getByRole('button', { name: 'Fermer Images' }).click()
  await expect(page.getByRole('button', { name: 'Afficher la vidéo', exact: true })).toBeVisible()
})

test('Local poursuit une vraie lecture HTML5 sous Images sans changement de surface', async ({ page, request }) => {
  const c = await setup(page, request)
  const url = `/api/v1/videos/${c.video.id}/sources/${c.video.sources[0].id}/download`
  await expect.poll(async () => (await request.post(url)).status(), { timeout: 15000 }).not.toBe(503)
  await expect.poll(async () => (await (await request.get(url)).json()).status).toBe('available')
  await page.reload()
  const media = page.locator('video')
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2)
  await media.evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play() })
  const time = await media.evaluate((v: HTMLVideoElement) => v.currentTime)
  await c.images.click()
  await expect(c.panel).toBeVisible()
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(time + 0.2)
  expect(await media.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false)
  await c.panel.getByRole('button', { name: 'Fermer Images' }).click()
  expect(await media.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false)
})
