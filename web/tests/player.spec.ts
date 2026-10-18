import { expect, test } from './fixtures'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/videos/42', route => route.fulfill({ json: {
    id: 42, created_at: '2026-10-12', tags: [], person_ids: [],
    sources: [{ id: 17, provider: 'youtube', external_id: 'abcdefghijk', title: 'Vidéo test',
      canonical_url: 'https://www.youtube.com/watch?v=abcdefghijk' }],
  } }))
  await page.route('**/note', route => route.fulfill({ status: 404, json: { error: { code: 'note_not_found' } } }))
  await page.route('**/transcript', route => route.fulfill({ json: {
    language: 'fr', provenance: 'youtube_auto', last_fetched_at: '2026-10-12T10:00:00Z',
    items: [{ start_ms: 1250, text: 'Transcription indépendante' }, { start_ms: 12750, text: 'Deuxième passage' }],
  } }))
})

for (const state of [-1, 0, 1, 2, 3, 5]) {
  test(`navigation depuis l'état ${state}, clavier et clics répétés sans arrondir les millisecondes`, async ({ page }) => {
    const requests: string[] = []
    page.on('request', request => {
      if (request.url().endsWith('/transcript')) requests.push(request.method())
    })
    await page.goto('/videos/42')
    await expect(page.locator('.youtube-frame iframe')).toBeVisible()
    await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
    expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
    expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.state)).toBe(-1)
    await page.evaluate(state => window.youtubeTest.players.at(-1)!.emitState(state), state)
    const first = page.getByRole('button', { name: 'Aller à 0:01 dans le lecteur' })
    await first.focus()
    await first.press('Enter')
    await first.press('Space')
    await page.getByRole('button', { name: 'Aller à 0:12 dans le lecteur' }).click()
    const prepare = [-1, 0, 5].includes(state)
    expect(await page.evaluate(() => {
      const player = window.youtubeTest.players.at(-1)!
      return { state: player.state, position: player.position, calls: player.navigationCalls }
    })).toEqual({
      state: prepare ? 5 : state === 2 ? 2 : 1,
      position: 12.75,
      calls: [1.25, 1.25, 12.75].map(seconds => prepare
        ? { command: 'cue', seconds, videoId: 'abcdefghijk' }
        : { command: 'seek', seconds, allowSeekAhead: true }),
    })
    expect(requests).toEqual(['GET'])
  })
}

test('un timestamp réaffiche le lecteur masqué sans reprendre la lecture', async ({ page }) => {
  await page.goto('/videos/42')
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(1))
  await page.getByRole('button', { name: 'Masquer la vidéo' }).click()
  await page.getByRole('button', { name: 'Aller à 0:12 dans le lecteur' }).click()
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  expect(await page.evaluate(() => window.youtubeTest.players.map(player => ({
    state: player.state, position: player.position,
  })))).toEqual([{ state: 2, position: 12.75 }])
})

test('aucune commande en attente avant onReady, après erreur ou après réessai', async ({ page }) => {
  await page.addInitScript(() => { window.youtubeTest = { players: [], autoReady: false, confirmPause: true } })
  await page.goto('/videos/42')
  const timestamp = page.getByRole('button', { name: 'Aller à 0:12 dans le lecteur' })
  await timestamp.click()
  await expect(page.getByRole('status').filter({ hasText: 'Navigation non effectuée' })).toBeVisible()
  await page.evaluate(() => {
    const player = window.youtubeTest.players.at(-1)!
    player.options.events.onReady({ target: player })
  })
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
  await timestamp.click()
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.position)).toBe(12.75)
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.options.events.onError({ data: 100 }))
  await timestamp.click()
  await expect(page.getByRole('status').filter({ hasText: 'Navigation non effectuée' })).toBeVisible()
  await page.evaluate(() => { window.youtubeTest.autoReady = true })
  await page.getByRole('button', { name: 'Réessayer le lecteur' }).click()
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
  await timestamp.click()
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.state)).toBe(5)
})

test('un clic pendant le masquage ne court-circuite pas l’arrêt, puis réaffichage sans commande différée', async ({ page }) => {
  await page.clock.install()
  await page.goto('/videos/42')
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  await page.evaluate(() => {
    window.youtubeTest.confirmPause = false
    window.youtubeTest.players.at(-1)!.emitState(1)
  })
  await page.getByRole('button', { name: 'Masquer la vidéo' }).click()
  const timestamp = page.getByRole('button', { name: 'Aller à 0:12 dans le lecteur' })
  await timestamp.click()
  await expect(page.getByRole('status').filter({ hasText: 'Mise en pause du lecteur en cours' })).toBeVisible()
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
  await page.clock.runFor(1100)
  await expect(page.getByRole('button', { name: 'Afficher la vidéo' })).toBeVisible()
  await timestamp.click()
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await page.clock.runFor(100)
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
  await timestamp.click()
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.position)).toBe(12.75)
})

test('changer de fiche invalide le clic refusé et les événements de l’ancienne vidéo', async ({ page, request }) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trnav000001' } })).json()
  await page.addInitScript(() => { window.youtubeTest = { players: [], autoReady: false, confirmPause: true } })
  await page.goto('/videos/42')
  await page.getByRole('button', { name: 'Aller à 0:12 dans le lecteur' }).click()
  await page.getByRole('link', { name: 'Sillage, accueil' }).click()
  await expect(page).toHaveURL('/')
  await page.evaluate(() => {
    const old = window.youtubeTest.players.at(-1)!
    old.options.events.onReady({ target: old })
    old.emitState(5)
    window.youtubeTest.autoReady = true
  })
  await page.locator(`.video-card a[href="/videos/${video.id}"]`).click()
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  expect(await page.evaluate(() => window.youtubeTest.players.every(player => player.navigationCalls.length === 0))).toBe(true)
})

test('API bloquée et commande en exception restent explicites sans faux succès', async ({ page }) => {
  await page.route('https://www.youtube.com/iframe_api', route => route.abort())
  await page.goto('/videos/42')
  await expect(page.getByRole('alert')).toContainText('Impossible de charger')
  const timestamp = page.getByRole('button', { name: 'Aller à 0:12 dans le lecteur' })
  await timestamp.click()
  await expect(page.getByRole('status').filter({ hasText: 'Navigation non effectuée' })).toBeVisible()
  await page.unroute('https://www.youtube.com/iframe_api')
  await page.getByRole('button', { name: 'Réessayer le lecteur' }).click()
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  await page.evaluate(() => {
    window.youtubeTest.players.at(-1)!.cueVideoById = () => { throw new Error('Commande impossible') }
  })
  await timestamp.click()
  await expect(page.getByRole('alert')).toContainText('La commande YouTube a échoué')
  await page.evaluate(() => {
    const old = window.youtubeTest.players.at(-1)!
    old.options.events.onReady({ target: old })
  })
  await timestamp.click()
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.destroyed)).toBe(true)
  await expect(page.locator('.youtube-frame iframe')).toHaveCount(0)
})

test('pause avant masquage, position et instance conservées sans reprise', async ({ page }) => {
  await page.goto('/videos/42')
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await page.evaluate(() => {
    const player = window.youtubeTest.players.at(-1)!
    player.position = 42.75
    player.emitState(1)
  })
  await page.getByRole('button', { name: 'Masquer la vidéo' }).click()
  await expect(page.locator('.youtube-frame iframe')).toBeHidden()
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.state)).toBe(2)
  await expect(page.getByText('Transcription indépendante')).toBeVisible()
  await page.getByRole('button', { name: 'Afficher la vidéo' }).click()
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  expect(await page.evaluate(() => window.youtubeTest.players.map(player => ({
    state: player.state, position: player.position, destroyed: player.destroyed,
  })))).toEqual([{ state: 2, position: 42.75, destroyed: false }])
  await page.getByRole('link', { name: 'Sillage, accueil' }).click()
  await expect(page).toHaveURL('/')
  await expect.poll(() => page.evaluate(() => window.youtubeTest.players.every(player => player.destroyed))).toBe(true)
})

test('une pause non confirmée détruit le lecteur avant de le masquer', async ({ page }) => {
  await page.goto('/videos/42')
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  await page.evaluate(() => {
    window.youtubeTest.confirmPause = false
    window.youtubeTest.players.at(-1)!.emitState(1)
  })
  await page.getByRole('button', { name: 'Masquer la vidéo' }).click()
  await expect(page.getByRole('button', { name: 'Afficher la vidéo' })).toBeVisible()
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.destroyed)).toBe(true)
  await page.getByRole('button', { name: 'Afficher la vidéo' }).click()
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.state)).toBe(-1)
})

test('une reprise tardive après masquage détruit le lecteur sans lecture en arrière-plan', async ({ page }) => {
  await page.goto('/videos/42')
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  await page.getByRole('button', { name: 'Masquer la vidéo' }).click()
  await page.evaluate(() => {
    window.youtubeTest.confirmPause = false
    window.youtubeTest.players.at(-1)!.emitState(1)
  })
  await expect(page.locator('.youtube-frame iframe')).toHaveCount(0)
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.destroyed)).toBe(true)
  await expect(page.getByText('Transcription indépendante')).toBeVisible()
  await page.getByRole('button', { name: 'Afficher la vidéo' }).click()
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
})

for (const [code, message] of [[100, 'indisponible ou privée'], [101, 'n’autorise pas'], [153, 'identifier cette intégration']] as const) {
  test(`erreur YouTube ${code} isolée et réessai`, async ({ page }) => {
    await page.goto('/videos/42')
    await expect(page.locator('.youtube-frame iframe')).toBeVisible()
    await page.evaluate(code => window.youtubeTest.players.at(-1)!.options.events.onError({ data: code }), code)
    await expect(page.getByRole('alert')).toContainText(message)
    await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toBeVisible()
    await expect(page.getByText('Transcription indépendante')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Ouvrir sur YouTube' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Réessayer le lecteur' }).click()
    await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  })
}

test('API bloquée puis nouvel essai sans toucher aux autres panneaux', async ({ page }) => {
  await page.route('https://www.youtube.com/iframe_api', route => route.abort())
  await page.goto('/videos/42')
  await expect(page.getByRole('alert')).toContainText('Impossible de charger l’API YouTube')
  await expect(page.getByText('Transcription indépendante')).toBeVisible()
  await page.unroute('https://www.youtube.com/iframe_api')
  await page.getByRole('button', { name: 'Réessayer le lecteur' }).click()
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
})

test('masquage avant onReady et événements tardifs ne réactivent pas un lecteur détruit', async ({ page }) => {
  await page.addInitScript(() => { window.youtubeTest = { players: [], autoReady: false, confirmPause: true } })
  await page.goto('/videos/42')
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await page.getByRole('button', { name: 'Masquer la vidéo' }).click()
  await expect(page.locator('.youtube-frame iframe')).toHaveCount(0)
  await page.evaluate(() => {
    const old = window.youtubeTest.players[0]
    old.options.events.onReady({ target: old })
    old.options.events.onError({ data: 100 })
    window.youtubeTest.autoReady = true
  })
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', { name: 'Afficher la vidéo' }).click()
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  expect(await page.evaluate(() => window.youtubeTest.players.map(player => player.destroyed))).toEqual([true, false])
})

test('initialisation sans onReady bornée, événements tardifs ignorés puis reprise', async ({ page }) => {
  await page.addInitScript(() => { window.youtubeTest = { players: [], autoReady: false, confirmPause: true } })
  await page.clock.install()
  await page.goto('/videos/42')
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await page.clock.runFor(15_100)
  await expect(page.getByRole('alert')).toContainText('ne répond pas')
  await page.evaluate(() => {
    const old = window.youtubeTest.players[0]
    old.options.events.onReady({ target: old })
    window.youtubeTest.autoReady = true
  })
  await expect(page.getByRole('alert')).toContainText('ne répond pas')
  await page.getByRole('button', { name: 'Réessayer le lecteur' }).click()
  await page.clock.runFor(100)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
})

test('chargement du script sans callback borné et indépendant de la note', async ({ page }) => {
  await page.route('https://www.youtube.com/iframe_api', route => route.fulfill({ contentType: 'application/javascript', body: '' }))
  await page.clock.install()
  await page.goto('/videos/42')
  await expect(page.getByText('Chargement du lecteur YouTube…')).toBeVisible()
  // Ne pas faire expirer artificiellement le GET de note encore en transit.
  await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toBeVisible()
  await page.clock.runFor(15_100)
  await expect(page.getByRole('alert')).toContainText('trop long')
  await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toBeVisible()
  await expect(page.getByText('Transcription indépendante')).toBeVisible()
})


// Ces scénarios isolent le lecteur/transcript : la source simulée n'existe pas en SQLite.
test.beforeEach(async ({ page }) => {
  await page.route('**/download', route => route.fulfill({
    json: { status: 'not_downloaded', media_file: null, error: null },
  }))
})


test('le plein écran est déclaré une seule fois et reste utilisable', async ({ page }) => {
  await page.goto('/videos/42')
  const iframe = page.locator('.youtube-frame iframe')
  await expect(iframe).toBeVisible()
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  await expect(iframe).toHaveAttribute('allow', 'encrypted-media; fullscreen; picture-in-picture')
  expect(await iframe.getAttribute('allowfullscreen')).toBeNull()
  // Le double about:blank permet un vrai geste utilisateur et l'API native, sans réseau YouTube.
  const frame = page.frameLocator('.youtube-frame iframe')
  await iframe.evaluate((element: HTMLIFrameElement) => {
    const document = element.contentDocument!
    const button = document.createElement('button')
    button.textContent = 'Plein écran test'
    button.onclick = () => { void document.documentElement.requestFullscreen() }
    document.body.append(button)
  })
  await frame.getByRole('button', { name: 'Plein écran test' }).click()
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.tagName)).toBe('IFRAME')
  await page.evaluate(() => document.exitFullscreen())
})
