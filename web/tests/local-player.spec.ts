import type { APIRequestContext, Page } from '@playwright/test'
import { test, expect } from './fixtures'

/** Conserve un vrai WebM par le backend réel, avec la seule acquisition distante simulée. */
async function setup(page: Page, request: APIRequestContext, downloaded = true) {
  const externalID = 'trlp' + test.info().testId.slice(-7)
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/' + externalID } })).json()
  const downloadURL = `/api/v1/videos/${video.id}/sources/${video.sources[0].id}/download`
  if (downloaded) {
    await request.post(downloadURL)
    await expect.poll(async () => (await (await request.get(downloadURL)).json()).status).toBe('available')
  }
  await page.goto('/videos/' + video.id)
  await expect(page.getByLabel('Mode de lecture')).toHaveValue('youtube')
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  return { video, downloadURL, mode: page.getByLabel('Mode de lecture'), media: page.locator('video') }
}

/** Attend une position réellement décodable après un seek HTML5. */
async function position(page: Page, seconds: number) {
  await page.locator('video').evaluate((v: HTMLVideoElement, t) => { v.currentTime = t }, seconds)
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 2)).toBe(true)
}

test('vrai média : décodage, lecture, pause, seek HTTP et masquage', async ({ page, request }) => {
  const c = await setup(page, request)
  const ranges: string[] = []
  page.on('request', r => { if (r.url().endsWith('/content')) ranges.push(r.headers()['range'] ?? '') })
  await c.mode.selectOption('local')
  await expect.poll(() => c.media.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2)
  expect(await c.media.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
  expect(await c.media.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(160)
  await c.media.evaluate((v: HTMLVideoElement) => v.play())
  await expect.poll(() => c.media.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.2)
  await page.getByRole('button', { name: 'Masquer la vidéo' }).click()
  expect(await c.media.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
  await page.getByRole('button', { name: 'Afficher la vidéo' }).click()
  await position(page, 95.123)
  expect(await c.media.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(95.123, 2)
  expect(await c.media.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
  expect(ranges.some(r => r.startsWith('bytes='))).toBe(true)
  const pixels = await c.media.evaluate((v: HTMLVideoElement) => {
    const canvas = document.createElement('canvas')
    canvas.width = 160; canvas.height = 90
    const context = canvas.getContext('2d')!
    context.drawImage(v, 0, 0)
    return [...context.getImageData(0, 0, 160, 90).data].some((n, i) => i % 4 !== 3 && n > 50)
  })
  expect(pixels).toBe(true)
  await page.screenshot({ path: test.info().outputPath('local-player.png'), fullPage: true })
})

test('bascule transfère la position en pause et conserve la session et autosauvegarde', async ({ page, request }) => {
  const c = await setup(page, request)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  const node = await editor.elementHandle()
  await editor.fill('Une connaissance durable')
  await page.evaluate(() => { const p = window.youtubeTest.players.at(-1)!; p.position = 12.345; p.emitState(1) })
  await c.mode.selectOption('local')
  await expect.poll(() => c.media.evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 2)).toBe(true)
  expect(await c.media.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(12.345, 2)
  expect(await c.media.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
  expect(await page.evaluate(() => window.youtubeTest.players[0].destroyed)).toBe(true)
  await position(page, 32.567)
  await c.mode.selectOption('youtube')
  await expect.poll(() => page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([
    { command: 'cue', seconds: 32.567, videoId: c.video.sources[0].external_id },
  ])
  expect(await node!.evaluate(n => n === document.querySelector('.cm-content'))).toBe(true)
  await expect.poll(async () => (await (await request.get(`/api/v1/videos/${c.video.id}/note`)).json()).content_md).toBe('Une connaissance durable')
  await editor.focus()
  await page.keyboard.press('Control+z')
  await expect(editor).toBeEmpty()
  await page.keyboard.press('Control+Shift+Z')
  await expect(editor).toContainText('Une connaissance durable')
})

test('erreur locale reste locale et la suppression décharge avant DELETE', async ({ page, request }) => {
  const c = await setup(page, request)
  await page.route('**/media-files/*/content', route => route.fulfill({ contentType: 'video/webm', body: 'not a video' }))
  await c.mode.selectOption('local')
  await expect(page.getByText(/Impossible de lire ce fichier local/)).toBeVisible()
  await expect(c.mode).toHaveValue('local')
  expect((await (await request.get(c.downloadURL)).json()).status).toBe('available')
  await page.unroute('**/media-files/*/content')
  await page.getByRole('button', { name: 'Réessayer le lecteur', exact: true }).click()
  await expect.poll(() => c.media.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2)
  await c.media.evaluate((v: HTMLVideoElement) => v.play())
  let unloaded = false
  await page.route('**/media-files/*', async route => {
    unloaded = await page.locator('video').evaluateAll(nodes => nodes.every(n => !n.getAttribute('src')))
    await route.continue()
  })
  await page.getByRole('button', { name: 'Supprimer le fichier local', exact: true }).click()
  await page.getByRole('button', { name: 'Confirmer la suppression' }).click()
  await expect(page.getByText(/Aucun fichier local\. Téléchargez/)).toBeVisible()
  expect(unloaded).toBe(true)
  await expect(c.mode).toHaveValue('local')
  await expect(c.media).toHaveCount(0)
  await page.reload()
  await expect(c.mode).toHaveValue('youtube')
})

test('fin de téléchargement conserve YouTube et son instance', async ({ page, request }) => {
  const c = await setup(page, request, false)
  await c.mode.selectOption('local')
  await expect(page.getByText(/Aucun fichier local\. Téléchargez/)).toBeVisible()
  await c.mode.selectOption('youtube')
  await expect(page.locator('iframe')).toBeVisible()
  const iframe = await page.locator('iframe').elementHandle()
  await request.post(c.downloadURL)
  await expect.poll(async () => (await (await request.get(c.downloadURL)).json()).status).toBe('available')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByText('Métadonnées et sources', { exact: true }).click()
  await expect(page.getByRole('region', { name: 'Fichier local', exact: true })).toContainText('WEBM')
  await expect(c.mode).toHaveValue('youtube')
  expect(await iframe!.evaluate(n => n === document.querySelector('iframe'))).toBe(true)
  await page.reload()
  await expect(c.mode).toHaveValue('youtube')
})
