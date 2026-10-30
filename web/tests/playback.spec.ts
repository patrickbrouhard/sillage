import { test, expect } from './fixtures'
import type { APIRequestContext, Page } from '@playwright/test'

/** Crée une vraie source ; seul le fournisseur vidéo est simulé par les fixtures. */
async function setup(request: APIRequestContext, position: number | null = null) {
  const externalID = 'trlp' + test.info().testId.slice(-7)
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/' + externalID } })).json()
  const source = video.sources[0]
  const path = `/api/v1/videos/${video.id}/sources/${source.id}/playback-progress`
  expect((await request.put(path, { data: { position_ms: position } })).status()).toBe(204)
  return { video, source, path }
}

/** Attend l'instance sans convertir un cued en lecture. */
async function ready(page: Page, id: number) {
  await page.goto('/videos/' + id)
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => Boolean(window.youtubeTest?.players.at(-1)))).toBe(true)
}

/** Fait avancer le double et l'horloge séparément, sans simuler du temps dans paused. */
async function advance(page: Page, seconds: number) {
  for (let i = 0; i < seconds; i++) {
    await page.evaluate(() => { window.youtubeTest.players.at(-1)!.position += 1 })
    await page.clock.runFor(1000)
  }
}

test('reprise réelle persistée, sans autoplay ni écriture à ouverture, pause qualifiée', async ({ page, request }) => {
  const c = await setup(request, 40000)
  await page.clock.install()
  const writes: number[] = []
  page.on('request', r => { if (r.url().endsWith('/playback-progress') && r.method() === 'PUT') writes.push(r.postDataJSON().position_ms) })
  await ready(page, c.video.id)
  await expect.poll(() => page.evaluate(() => window.youtubeTest.players.at(-1)!.state)).toBe(5)
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.position)).toBe(40)
  await page.clock.runFor(12000)
  expect(writes).toEqual([])
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(1))
  await advance(page, 3)
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(2))
  expect(writes).toEqual([])
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(1))
  await advance(page, 3)
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(2))
  await expect.poll(() => writes).toEqual([46000])
  await expect.poll(async () => (await (await request.get(c.path)).json()).position_ms).toBe(46000)
  await page.reload()
  await expect.poll(() => page.evaluate(() => window.youtubeTest?.players.at(-1)?.position)).toBe(46)
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.state)).toBe(5)
})

test('délai initial borné : réponse tardive ignorée après interaction', async ({ page, request }) => {
  const c = await setup(request, 70000)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/playback-progress', async route => {
    if (route.request().method() !== 'GET') return route.continue()
    await gate
    await route.fulfill({ json: { position_ms: 70000 } }).catch(() => {})
  })
  await page.clock.install()
  await page.goto('/videos/' + c.video.id)
  await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toBeVisible()
  expect(await page.locator('.youtube-frame iframe').count()).toBe(0)
  await page.clock.runFor(2100)
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await page.evaluate(() => { const p = window.youtubeTest.players.at(-1)!; p.position = 12; p.emitState(1) })
  release()
  await page.clock.runFor(1000)
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.position)).toBe(12)
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
  await expect(page.getByText('Point de reprise indisponible. Lecture possible depuis le début.')).toBeVisible()
})

test('suivi désactivé, seeks et réactivation ne déplacent pas et ne sauvegardent pas prématurément', async ({ page, request }) => {
  const c = await setup(request, 10000)
  const writes: Array<number | null> = []
  page.on('request', r => { if (r.url().endsWith('/playback-progress') && r.method() === 'PUT') writes.push(r.postDataJSON().position_ms) })
  await page.clock.install()
  await ready(page, c.video.id)
  const toggle = page.getByRole('button', { name: 'Suivre la progression', exact: true })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await page.evaluate(() => { const p = window.youtubeTest.players.at(-1)!; p.position = 50; p.emitState(1) })
  await advance(page, 12)
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(0))
  expect(writes).toEqual([])
  await toggle.click()
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.position)).toBe(62)
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(1))
  await advance(page, 3)
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(2))
  expect(writes).toEqual([])
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(1))
  await advance(page, 3)
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(2))
  await expect.poll(() => writes).toEqual([68000])
  await page.reload()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
})

test('seek natif détecté et seek de note : pause avant cinq secondes conserve la progression', async ({ page, request }) => {
  const c = await setup(request, 10000)
  await request.put('/api/v1/videos/' + c.video.id + '/note', { data: {
    expected_revision: 0,
    content_md: `[Départ](sillage://videos/${c.video.id}/sources/${c.source.id}?start_ms=30000)`,
  } })
  await page.clock.install()
  await ready(page, c.video.id)
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(1))
  await advance(page, 6)
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(2))
  await expect.poll(async () => (await (await request.get(c.path)).json()).position_ms).toBe(16000)
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await page.getByLabel('Lecture de la note').getByRole('button', { name: /Départ/ }).click()
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(1))
  await advance(page, 3)
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(2))
  expect((await (await request.get(c.path)).json()).position_ms).toBe(16000)
  await page.evaluate(() => { const p = window.youtubeTest.players.at(-1)!; p.position = 80; p.emitState(1) })
  await advance(page, 3)
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(2))
  expect((await (await request.get(c.path)).json()).position_ms).toBe(16000)
})

test('fin naturelle courte après reprise efface, événements de fin répétés sans recréation', async ({ page, request }) => {
  const c = await setup(request, 117000)
  await page.clock.install()
  await ready(page, c.video.id)
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(1))
  await advance(page, 2)
  await page.evaluate(() => { const p = window.youtubeTest.players.at(-1)!; p.position = 120; p.emitState(0) })
  await expect.poll(async () => (await (await request.get(c.path)).json()).position_ms).toBeNull()
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(2))
  await page.clock.runFor(20000)
  expect((await (await request.get(c.path)).json()).position_ms).toBeNull()
})

test('réponse perdue : pas de réessai aveugle, prochaine progression fraîche acceptée', async ({ page, request }) => {
  const c = await setup(request)
  await page.clock.install()
  await ready(page, c.video.id)
  const writes: Array<number | null> = []
  await page.route('**/playback-progress', async route => {
    if (route.request().method() === 'GET') return route.continue()
    writes.push(route.request().postDataJSON().position_ms)
    if (writes.length === 1) return route.abort()
    return route.continue()
  })
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(1))
  await advance(page, 6)
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(2))
  await expect.poll(() => writes.length).toBe(1)
  await expect(page.getByText(/Enregistrement du point de reprise non confirmé/)).toBeVisible()
  await page.clock.runFor(30000)
  expect(writes.length).toBe(1)
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(1))
  await advance(page, 11)
  await expect.poll(() => writes.length).toBe(2)
  await expect.poll(async () => (await (await request.get(c.path)).json()).position_ms).toBe(writes[1])
})

test('Local et YouTube partagent le départ et le choix du suivi, éditeur conservé', async ({ page, request }) => {
  const c = await setup(request, 20000)
  const download = `/api/v1/videos/${c.video.id}/sources/${c.source.id}/download`
  await expect.poll(async () => (await request.post(download)).status()).not.toBe(503)
  await expect.poll(async () => (await (await request.get(download)).json()).status).toBe('available')
  await page.goto('/videos/' + c.video.id)
  const media = page.locator('video')
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 2)).toBe(true)
  expect(await media.evaluate((v: HTMLVideoElement) => ({ time: v.currentTime, paused: v.paused }))).toEqual({ time: 20, paused: true })
  const editor = await page.getByRole('textbox', { name: 'Note Markdown' }).elementHandle()
  const toggle = page.getByRole('button', { name: 'Suivre la progression', exact: true })
  await toggle.click()
  await page.getByRole('button', { name: 'YouTube', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.youtubeTest?.players.at(-1)?.state)).toBe(5)
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.position)).toBe(20)
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('button', { name: 'Local', exact: true }).click()
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 2)).toBe(true)
  await toggle.click()
  await media.evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play() })
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10000 }).toBeGreaterThan(26)
  await media.evaluate((v: HTMLVideoElement) => v.pause())
  await expect.poll(async () => (await (await request.get(c.path)).json()).position_ms).toBeGreaterThan(25000)
  expect(await editor!.evaluate(n => n === document.querySelector('.cm-content'))).toBe(true)
})

test('fermeture et événements d’une ancienne surface ne créent pas de point non qualifié', async ({ page, request }) => {
  const c = await setup(request, 10000)
  await page.clock.install()
  await ready(page, c.video.id)
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(1))
  await advance(page, 3)
  await page.getByRole('link', { name: 'Sillage, accueil' }).click()
  await page.evaluate(() => { const p = window.youtubeTest.players.at(-1)!; p.position = 90; p.emitState(0) })
  await page.clock.runFor(12000)
  expect((await (await request.get(c.path)).json()).position_ms).toBe(10000)
})

test('écriture en vol : désactiver supprime le dernier instantané en attente', async ({ page, request }) => {
  const c = await setup(request, 10000)
  await page.clock.install()
  await ready(page, c.video.id)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const writes: number[] = []
  await page.route('**/playback-progress', async route => {
    if (route.request().method() !== 'PUT') return route.continue()
    writes.push(route.request().postDataJSON().position_ms)
    await gate
    return route.fulfill({ status: 204 })
  })
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(1))
  await advance(page, 11)
  await expect.poll(() => writes.length).toBe(1)
  await advance(page, 11)
  expect(writes.length).toBe(1)
  await page.getByRole('button', { name: 'Suivre la progression', exact: true }).click()
  release()
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(2))
  await page.clock.runFor(15000)
  expect(writes.length).toBe(1)
})

test('restauration en échec et réponse d’une ancienne fiche restent sans effet tardif', async ({ page, request }) => {
  const c = await setup(request, 50000)
  const other = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/tr' + test.info().testId.slice(-9) } })).json()
  const otherPath = `/api/v1/videos/${other.id}/sources/${other.sources[0].id}/playback-progress`
  await request.put(otherPath, { data: { position_ms: 20000 } })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**' + c.path, async route => {
    await gate
    await route.fulfill({ json: { position_ms: 50000 } }).catch(() => {})
  })
  await page.goto('/videos/' + c.video.id)
  await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toBeVisible()
  await page.getByRole('link', { name: 'Sillage, accueil' }).click()
  await page.locator(`a[href="/videos/${other.id}"]`).first().click()
  await expect.poll(() => page.evaluate(() => window.youtubeTest?.players.at(-1)?.position)).toBe(20)
  release()
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.state)).toBe(5)
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toHaveLength(1)
  await page.route('**' + otherPath, route => route.fulfill({ status: 500, json: { error: { code: 'internal_error' } } }))
  await page.reload()
  await expect(page.getByText('Point de reprise indisponible. Lecture possible depuis le début.')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.youtubeTest?.players.at(-1)?.state)).toBe(-1)
})

test('bascule vers Local conserve les secondes acquises après seek, sans qualification immédiate', async ({ page, request }) => {
  const c = await setup(request, 10000)
  const download = `/api/v1/videos/${c.video.id}/sources/${c.source.id}/download`
  await expect.poll(async () => (await request.post(download)).status(), { timeout: 15000 }).not.toBe(503)
  await expect.poll(async () => (await (await request.get(download)).json()).status).toBe('available')
  await page.clock.install()
  await page.goto('/videos/' + c.video.id)
  await expect(page.locator('video')).toBeVisible()
  await page.getByRole('button', { name: 'YouTube', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.youtubeTest?.players.at(-1)?.state)).toBe(5)
  await page.evaluate(() => { const p = window.youtubeTest.players.at(-1)!; p.position = 50; p.emitState(1) })
  await advance(page, 3)
  await page.getByRole('button', { name: 'Local', exact: true }).click()
  const media = page.locator('video')
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 2)).toBe(true)
  expect((await (await request.get(c.path)).json()).position_ms).toBe(10000)
  // Le vrai média avance en temps réel ; les timers redeviennent natifs pour cette partie.
  await page.clock.resume()
  await media.evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play() })
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 6000 }).toBeGreaterThan(56.2)
  await media.evaluate((v: HTMLVideoElement) => v.pause())
  await expect.poll(async () => (await (await request.get(c.path)).json()).position_ms).toBeGreaterThan(56000)
})
