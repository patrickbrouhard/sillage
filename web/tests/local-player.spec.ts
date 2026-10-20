import type { APIRequestContext, Page } from '@playwright/test'
import { test, expect } from './fixtures'

/** Conserve un vrai WebM par le backend réel, avec la seule acquisition distante simulée. */
async function setup(page: Page, request: APIRequestContext, downloaded = true) {
  const externalID = 'trlp' + test.info().testId.slice(-7)
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/' + externalID } })).json()
  const downloadURL = `/api/v1/videos/${video.id}/sources/${video.sources[0].id}/download`
  if (downloaded) {
    // Le serveur n'accepte qu'une acquisition globale ; la préparation des tests attend sa place.
    await expect.poll(async () => (await request.post(downloadURL)).status(), { timeout: 15_000 }).not.toBe(503)
    await expect.poll(async () => (await (await request.get(downloadURL)).json()).status).toBe('available')
  }
  await page.goto('/videos/' + video.id)
  await expect(page.getByLabel('Mode de lecture').getByRole('button', { name: downloaded ? 'Local' : 'YouTube', exact: true })).toHaveAttribute('aria-pressed', 'true')
  // Les parcours de bascule préparent explicitement leur point de départ distant.
  await page.getByRole('button', { name: 'YouTube', exact: true }).click()
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  return { video, downloadURL, mode: page.getByLabel('Mode de lecture'), media: page.locator('video') }
}

/** Attend une position réellement décodable après un seek HTML5. */
async function position(page: Page, seconds: number) {
  // Attendre aussi le départ initial avant de simuler un seek de l'utilisateur.
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 2)).toBe(true)
  await page.locator('video').evaluate((v: HTMLVideoElement, t) => { v.currentTime = t }, seconds)
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 2)).toBe(true)
}

test('vrai média : décodage, lecture, pause, seek HTTP et masquage', async ({ page, request }) => {
  const c = await setup(page, request)
  const ranges: string[] = []
  page.on('request', r => { if (r.url().endsWith('/content')) ranges.push(r.headers()['range'] ?? '') })
  await c.mode.getByRole('button', { name: 'Local', exact: true }).click()
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
  await c.mode.getByRole('button', { name: 'Local', exact: true }).click()
  await expect.poll(() => c.media.evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 2)).toBe(true)
  expect(await c.media.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(12.345, 2)
  expect(await c.media.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
  expect(await page.evaluate(() => window.youtubeTest.players[0].destroyed)).toBe(true)
  await expect(c.mode.getByRole('button', { name: 'Local', exact: true })).toBeFocused()
  await position(page, 32.567)
  await c.mode.getByRole('button', { name: 'YouTube', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([
    { command: 'cue', seconds: 32.567, videoId: c.video.sources[0].external_id },
  ])
  await c.mode.getByRole('button', { name: 'Local', exact: true }).click()
  await expect.poll(() => c.media.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(32.567, 2)
  await expect(page.locator('.player-switch-status')).toBeEmpty()
  expect(await c.media.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
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
  await c.mode.getByRole('button', { name: 'Local', exact: true }).click()
  await expect(page.getByText(/Impossible de lire ce fichier local/)).toBeVisible()
  await expect(c.mode.getByRole('button', { name: 'Local', exact: true })).toHaveAttribute('aria-pressed', 'true')
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
  await page.getByRole('button', { name: 'Informations', exact: true }).click()
  await page.getByRole('button', { name: 'Supprimer le fichier local', exact: true }).click()
  await page.getByRole('button', { name: 'Confirmer la suppression' }).click()
  await expect(page.getByText(/Aucun fichier local\. Téléchargez/)).toBeVisible()
  expect(unloaded).toBe(true)
  await expect(c.mode.getByRole('button', { name: 'Local', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(c.media).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Recharger le lecteur local' })).toHaveCount(0)
  await page.reload()
  await expect(c.mode.getByRole('button', { name: 'YouTube', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('fin de téléchargement conserve YouTube et son instance', async ({ page, request }) => {
  const c = await setup(page, request, false)
  await c.mode.getByRole('button', { name: 'Local', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Télécharger cette vidéo')
  await page.getByRole('button', { name: 'Annuler', exact: true }).click()
  await c.mode.getByRole('button', { name: 'YouTube', exact: true }).click()
  await expect(page.locator('iframe')).toBeVisible()
  const iframe = await page.locator('iframe').elementHandle()
  await expect.poll(async () => (await request.post(c.downloadURL)).status()).not.toBe(503)
  await expect.poll(async () => (await (await request.get(c.downloadURL)).json()).status).toBe('available')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByRole('tab', { name: 'Informations', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Fichier local', exact: true })).toContainText('WEBM')
  await expect(c.mode.getByRole('button', { name: 'YouTube', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(await iframe!.evaluate(n => n === document.querySelector('iframe'))).toBe(true)
  await page.reload()
  await expect(c.mode.getByRole('button', { name: 'Local', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('temps, transcription, références et capture utilisent la timeline locale', async ({ page, request }) => {
  const c = await setup(page, request)
  await request.post(`/api/v1/videos/${c.video.id}/sources/${c.video.sources[0].id}/transcript`)
  await page.reload()
  await c.mode.getByRole('button', { name: 'Local', exact: true }).click()
  await expect.poll(() => c.media.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2)
  await position(page, 12.345)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await editor.click()
  await page.getByRole('button', { name: '+ Temps', exact: true }).click()
  await expect.poll(async () => (await (await request.get(`/api/v1/videos/${c.video.id}/note`)).json()).content_md).toContain('start_ms=12345')
  const calls: number[] = []
  await page.route('**/captures', route => {
    calls.push(route.request().postDataJSON().timestamp_ms)
    return route.fulfill({ status: 503, json: { error: { code: 'capture_busy' } } })
  })
  await page.getByRole('button', { name: '+ Capture', exact: true }).click()
  await expect.poll(() => calls).toEqual([12345])
  await page.getByRole('button', { name: 'Masquer la vidéo' }).click()
  await page.getByRole('button', { name: /Aller à .* dans le lecteur/ }).first().click()
  await expect(c.media).toBeVisible()
  await expect.poll(() => c.media.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(2.96, 2)
  expect(await c.media.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await page.getByLabel('Lecture de la note').getByRole('button').first().click()
  await expect.poll(() => c.media.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(12.345, 2)
  expect(await page.evaluate(() => (window.youtubeTest?.players ?? []).every(p => p.navigationCalls.length === 0))).toBe(true)
})

test('initialisation retardée, timestamp refusé et bascules rapides sans commande tardive', async ({ page, request }) => {
  const c = await setup(page, request)
  await request.post(`/api/v1/videos/${c.video.id}/sources/${c.video.sources[0].id}/transcript`)
  await page.reload()
  await c.mode.getByRole('button', { name: 'YouTube', exact: true }).click()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/media-files/*/content', async route => {
    await gate
    await route.continue().catch(() => {})
  })
  await c.mode.getByRole('button', { name: 'Local', exact: true }).click()
  await page.getByRole('button', { name: /Aller à .* dans le lecteur/ }).first().click()
  await expect(page.getByText(/Navigation non effectuée : le lecteur local/)).toBeVisible()
  release()
  await expect.poll(() => c.media.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2)
  expect(await c.media.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(0)
  await position(page, 30)
  const previousMedia = await c.media.elementHandle()
  await page.evaluate(() => { window.youtubeTest.autoReady = false })
  await c.mode.getByRole('button', { name: 'YouTube', exact: true }).click()
  await expect(page.locator('iframe')).toBeVisible()
  await c.mode.getByRole('button', { name: 'Local', exact: true }).click()
  await page.evaluate(() => {
    const old = window.youtubeTest.players.at(-1)!
    old.options.events.onReady({ target: old })
    old.emitState(1)
  })
  await previousMedia!.evaluate(v => {
    v.dispatchEvent(new Event('loadedmetadata'))
    v.dispatchEvent(new Event('error'))
  })
  await expect(c.mode.getByRole('button', { name: 'Local', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText(/Impossible de lire ce fichier local/)).toHaveCount(0)
  await expect(page.locator('iframe')).toHaveCount(0)
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
  await expect.poll(() => c.media.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(30, 2)
  await expect.poll(() => c.media.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2)
  expect(await c.media.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
})

test('lecteur local étroit : note stable et commandes accessibles', async ({ page, request }) => {
  const c = await setup(page, request)
  await c.mode.getByRole('button', { name: 'Local', exact: true }).click()
  await expect.poll(() => c.media.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  const node = await editor.elementHandle()
  for (const width of [1440, 375, 320]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.getByRole('button', { name: 'Informations', exact: true })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath(`local-${width}.png`), fullPage: true })
  }
  expect(await node!.evaluate(n => n === document.querySelector('.cm-content'))).toBe(true)
})

test('choix initial attend la disponibilité sans YouTube et laisse la note accessible', async ({ page, request }) => {
  const c = await setup(page, request)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/download', async route => {
    await gate
    await route.continue()
  })
  await page.reload()
  await expect(page.getByRole('status').filter({ hasText: 'Consultation du fichier local…' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toBeVisible()
  expect(await page.evaluate(() => (window.youtubeTest?.players.length ?? 0))).toBe(0)
  await expect(page.locator('video, iframe')).toHaveCount(0)
  release()
  await expect(c.mode.getByRole('button', { name: 'Local', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => c.media.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2)
  expect(await c.media.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
  expect(await page.evaluate(() => (window.youtubeTest?.players.length ?? 0))).toBe(0)
})

test('échec de consultation initiale ouvre YouTube sans bascule après rétablissement', async ({ page, request }) => {
  const c = await setup(page, request)
  await page.route('**/download', route => route.fulfill({ status: 500, json: { error: { code: 'internal_error' } } }))
  await page.reload()
  await expect(c.mode.getByRole('button', { name: 'YouTube', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.unroute('**/download')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByRole('tab', { name: 'Informations', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Fichier local', exact: true })).toContainText('WEBM')
  await expect(c.mode.getByRole('button', { name: 'YouTube', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('départ YouTube vierge : pas de faux avertissement', async ({ page, request }) => {
  const c = await setup(page, request, false)
  await expect.poll(async () => (await request.post(c.downloadURL)).status()).not.toBe(503)
  await expect.poll(async () => (await (await request.get(c.downloadURL)).json()).status).toBe('available')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByRole('tab', { name: 'Informations', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Fichier local', exact: true })).toContainText('WEBM')
  await c.mode.getByRole('button', { name: 'Local', exact: true }).click()
  await expect(page.locator('.player-switch-status')).toBeEmpty()
  await expect.poll(() => c.media.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(0)
})

test('référence depuis un départ préparé lance la lecture puis transfère le temps annoncé', async ({ page, request }) => {
  const c = await setup(page, request)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await editor.fill('[cible](sillage://videos/' + c.video.id + '/sources/' + c.video.sources[0].id + '?start_ms=80000)')
  await c.mode.getByRole('button', { name: 'Local', exact: true }).click()
  await position(page, 40)
  await c.mode.getByRole('button', { name: 'YouTube', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.youtubeTest.players.at(-1)!.state)).toBe(5)
  await editor.click()
  const before = await editor.textContent()
  await page.getByRole('button', { name: '+ Temps', exact: true }).click()
  await expect(page.getByText(/Temps indisponible/)).toBeVisible()
  expect(await editor.textContent()).toBe(before)
  const captures: string[] = []
  page.on('request', r => { if (r.url().endsWith('/captures')) captures.push(r.url()) })
  await page.getByRole('button', { name: '+ Capture', exact: true }).click()
  expect(captures).toEqual([])
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await page.getByLabel('Lecture de la note').getByRole('button').first().click()
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.state)).toBe(1)
  await page.getByRole('button', { name: 'Édition', exact: true }).click()
  await editor.click()
  await page.getByRole('button', { name: '+ Temps', exact: true }).click()
  const captureTimes: number[] = []
  await page.route('**/captures', route => {
    captureTimes.push(route.request().postDataJSON().timestamp_ms)
    return route.fulfill({ status: 503, json: { error: { code: 'capture_busy' } } })
  })
  await page.getByRole('button', { name: '+ Capture', exact: true }).click()
  await expect.poll(() => captureTimes).toEqual([80000])
  await expect(page.getByText(/Temps indisponible/)).toHaveCount(0)
  await c.mode.getByRole('button', { name: 'Local', exact: true }).click()
  await expect.poll(() => c.media.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(80, 2)
  await c.mode.getByRole('button', { name: 'YouTube', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.youtubeTest.players.at(-1)!.state)).toBe(5)
  await page.evaluate(() => { const p = window.youtubeTest.players.at(-1)!; p.position = 91.234; p.emitState(1) })
  await c.mode.getByRole('button', { name: 'Local', exact: true }).click()
  await expect.poll(() => c.media.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(91.234, 2)
})

for (const state of ['buffering', 'error'] as const) {
  test('position incertaine sans repli ancien : ' + state, async ({ page, request }) => {
    const c = await setup(page, request)
    await c.mode.getByRole('button', { name: 'Local', exact: true }).click()
    await position(page, 40)
    await c.mode.getByRole('button', { name: 'YouTube', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.youtubeTest.players.at(-1)!.state)).toBe(5)
    await page.evaluate(kind => {
      const p = window.youtubeTest.players.at(-1)!
      if (kind === 'error') p.options.events.onError({ data: 100 })
      else p.emitState(3)
    }, state)
    await c.mode.getByRole('button', { name: 'Local', exact: true }).click()
    await expect(page.locator('.player-switch-status')).toContainText('sans transfert')
    await expect.poll(() => c.media.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(0)
    expect(await c.media.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
  })
}

test('départ préparé masqué reste transférable mais ne devient pas un temps confirmé', async ({ page, request }) => {
  const c = await setup(page, request)
  await c.mode.getByRole('button', { name: 'Local', exact: true }).click()
  await position(page, 40)
  await c.mode.getByRole('button', { name: 'YouTube', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.youtubeTest.players.at(-1)!.state)).toBe(5)
  await page.getByRole('button', { name: 'Masquer la vidéo' }).click()
  await page.getByRole('textbox', { name: 'Note Markdown' }).click()
  await page.getByRole('button', { name: '+ Temps', exact: true }).click()
  await expect(page.getByText(/Temps indisponible/)).toBeVisible()
  await c.mode.getByRole('button', { name: 'Local', exact: true }).click()
  await expect.poll(() => c.media.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(40, 2)
  await expect(page.locator('.player-switch-status')).toBeEmpty()
  expect(await c.media.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
})

test('une position bornée à la durée locale remplace la cible distante', async ({ page, request }) => {
  const c = await setup(page, request)
  await page.evaluate(() => { const p = window.youtubeTest.players.at(-1)!; p.position = 200; p.emitState(1) })
  await c.mode.getByRole('button', { name: 'Local', exact: true }).click()
  await expect.poll(() => c.media.evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 2)).toBe(true)
  const duration = await c.media.evaluate((v: HTMLVideoElement) => v.duration)
  expect(await c.media.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(duration, 2)
  await c.mode.getByRole('button', { name: 'YouTube', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls.at(-1)?.seconds)).toBeCloseTo(duration, 2)
  await c.mode.getByRole('button', { name: 'Local', exact: true }).click()
  await expect.poll(() => c.media.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(duration, 2)
})

test('une nouvelle référence après réessai lance une navigation explicite', async ({ page, request }) => {
  const c = await setup(page, request)
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.options.events.onError({ data: 100 }))
  await page.getByRole('button', { name: 'Réessayer le lecteur', exact: true }).click()
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Note Markdown' }).fill('[cible](sillage://videos/' + c.video.id + '/sources/' + c.video.sources[0].id + '?start_ms=80000)')
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await page.getByLabel('Lecture de la note').getByRole('button').first().click()
  await c.mode.getByRole('button', { name: 'Local', exact: true }).click()
  await expect.poll(() => c.media.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(80, 2)
  await expect(page.locator('.player-switch-status')).toBeEmpty()
})


// Les temps courants sont relus au clic, sans attendre une égalité avec la cible.
// Le cas resté à 40 s explicite la limite acceptée de fraîcheur du getter YouTube.
for (const observedSeconds of [80.123, 80.080, 40]) {
  for (const notify of [true, false]) {
    test('seek YouTube : temps annoncé ' + observedSeconds + ', événement stable ' + notify, async ({ page, request }) => {
      const c = await setup(page, request)
      const editor = page.getByRole('textbox', { name: 'Note Markdown' })
      const prefix = 'sillage://videos/' + c.video.id + '/sources/' + c.video.sources[0].id + '?start_ms='
      const reference = '[cible](' + prefix + '80123)'
      await editor.fill(reference)
      await page.evaluate(({ observed, notify }) => {
        const p = window.youtubeTest.players.at(-1)!
        p.position = 40
        p.emitState(1)
        p.emitState(2)
        p.seekTo = (seconds, allowSeekAhead) => {
          p.navigationCalls.push({ command: 'seek', seconds, allowSeekAhead })
          p.position = observed
          // Aucun buffering et, selon le cas, aucune nouvelle notification.
          if (notify) p.emitState(2)
        }
      }, { observed: observedSeconds, notify })
      await page.getByRole('button', { name: 'Lecture', exact: true }).click()
      await page.getByLabel('Lecture de la note').getByRole('button').first().click()
      expect(await page.evaluate(() => {
        const p = window.youtubeTest.players.at(-1)!
        return { call: p.navigationCalls.at(-1), state: p.getPlayerState(), seconds: p.getCurrentTime() }
      })).toEqual({
        call: { command: 'seek', seconds: 80.123, allowSeekAhead: true },
        state: 2,
        seconds: observedSeconds,
      })
      await page.getByRole('button', { name: 'Édition', exact: true }).click()
      await editor.click()
      await page.keyboard.press('Control+End')
      await page.getByRole('button', { name: '+ Temps', exact: true }).click()
      await expect(page.getByRole('alert').filter({ hasText: 'Temps indisponible' })).toHaveCount(0)
      const milliseconds = Math.round(observedSeconds * 1000)
      // Vérifier le Markdown sauvegardé, indépendamment des widgets CodeMirror.
      await page.getByRole('button', { name: 'Enregistrer la note', exact: true }).click()
      await expect.poll(async () => {
        const note = await (await request.get('/api/v1/videos/' + c.video.id + '/note')).json()
        return note.content_md
      }).toBe(reference + '[' + (milliseconds === 40000 ? '0:40' : '1:20') + '](' + prefix + milliseconds + ') ')
      const captures: number[] = []
      await page.route('**/captures', route => {
        captures.push(route.request().postDataJSON().timestamp_ms)
        return route.fulfill({ status: 503, json: { error: { code: 'capture_busy' } } })
      })
      await page.getByRole('button', { name: '+ Capture', exact: true }).click()
      await expect.poll(() => captures).toEqual([milliseconds])
      await c.mode.getByRole('button', { name: 'Local', exact: true }).click()
      await expect.poll(() => c.media.evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 2)).toBe(true)
      expect(await c.media.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(observedSeconds, 3)
      expect(await c.media.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
      await expect(page.locator('.player-switch-status')).toBeEmpty()
    })
  }
}
