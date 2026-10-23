import { expect, test } from './fixtures'
import { selectTheme } from './navigationHelpers'
import { groupTranscript } from '../src/transcriptPresentation'
import type { Locator, Page } from '@playwright/test'

/** Prépare une fiche dont la source est indépendante du contenu de la base de tests. */
async function mockVideo(page: Page, id = 42) {
  await page.route(`**/api/v1/videos/${id}`, route => route.fulfill({ json: {
    id, created_at: '2026-10-12', tags: [], person_ids: [],
    sources: [{ id: id + 10, provider: 'youtube', external_id: 'abcdefghijk', title: `Vidéo ${id}` }],
  } }))
  await page.route(`**/api/v1/videos/${id}/note`, route => route.fulfill({ status: 404, json: { error: { code: 'note_not_found' } } }))
}

/** Mesure le document pour ne pas confondre défilement du viewport et déplacement de barre. */
async function documentBox(locator: Locator) {
  return locator.evaluate(element => {
    const box = element.getBoundingClientRect()
    return { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height }
  })
}

const localTranscript = {
  language: 'fr', provenance: 'youtube_auto', last_fetched_at: '2026-10-12T10:00:00Z',
  items: [{ start_ms: 1000, text: 'Contenu enregistré' }],
}

test('regroupe sans réordonner, découper les mots ou perdre les blancs', () => {
  const items = [
    { start_ms: 0, text: ' \n' },
    { start_ms: 5100, text: 'Bon' },
    { start_ms: 5100, text: 'jour' },
    { start_ms: 9999, text: ' le' },
    { start_ms: 10000, text: ' monde' },
    { start_ms: 9000, text: ' !' },
    { start_ms: 25000, text: '\n ' },
    { start_ms: 60000, text: 'Suite' },
  ]
  const copy = structuredClone(items)
  const blocks = groupTranscript(items, 5)
  expect(blocks).toEqual([
    { start_ms: 5100, text: ' \nBonjour le' },
    { start_ms: 10000, text: ' monde' },
    { start_ms: 9000, text: ' !\n ' },
    { start_ms: 60000, text: 'Suite' },
  ])
  expect(blocks.map(block => block.text).join('')).toBe(items.map(item => item.text).join(''))
  expect(items).toEqual(copy)
  expect(groupTranscript([{ start_ms: 0, text: '\n  ' }], 10)).toEqual([])
  expect(groupTranscript([], 10)).toEqual([])
})

test('présente des paragraphes fluides sans modifier les fragments sur desktop et mobile', async ({ page }) => {
  const items = [
    { start_ms: 1200, text: 'Bon' },
    { start_ms: 1300, text: 'jour\nami\r\n' },
    { start_ms: 1400, text: 'Les  mots\trestent séparés et les lignes suivent la largeur disponible. '.repeat(5) },
    { start_ms: 11000, text: 'Autre\nintervalle.' },
  ]
  await mockVideo(page)
  await page.route('**/transcript', route => route.fulfill({ json: { ...localTranscript, items } }))
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/videos/42')
  await expect(page.locator('.transcript-block')).toHaveCount(2)
  const paragraph = page.locator('.transcript-block p').first()
  const originalText = items.slice(0, 3).map(item => item.text).join('')
  const desktopBox = await paragraph.boundingBox()

  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await paragraph.textContent()).toBe(originalText)
    expect(await paragraph.innerText()).toBe(originalText.replace(/\s+/g, ' ').trim())
    await expect(page.locator('.transcript-time')).toHaveText(['0:01', '0:11'])
    expect(await page.locator('.transcript-block p').last().textContent()).toBe(items[3].text)

    // Les mots de part et d'autre du saut source tiennent sur la même ligne.
    // Les lignes suivantes résultent seulement de la largeur du paragraphe.
    const layout = await paragraph.evaluate(element => {
      const text = element.firstChild!
      const word = document.createRange()
      word.setStart(text, 0); word.setEnd(text, 7)
      const first = word.getBoundingClientRect()
      word.setStart(text, 8); word.setEnd(text, 11)
      const next = word.getBoundingClientRect()
      const box = element.getBoundingClientRect()
      return {
        firstTop: first.top, nextTop: next.top, firstRight: first.right, nextLeft: next.left,
        height: box.height, width: box.width, lineHeight: parseFloat(getComputedStyle(element).lineHeight),
        overflow: element.scrollWidth > element.clientWidth,
      }
    })
    expect(layout.nextTop).toBe(layout.firstTop)
    expect(layout.nextLeft).toBeGreaterThan(layout.firstRight)
    expect(layout.height).toBeGreaterThan(layout.lineHeight)
    expect(layout.overflow).toBe(false)
    if (width === 375) {
      expect(layout.width).toBeLessThan(desktopBox!.width)
      expect(layout.height).toBeGreaterThan(desktopBox!.height)
    }
  }
})

test('acquiert via Go/SQLite et relit localement sans POST à ouverture', async ({ page, request }, info) => {
  const externalID = `tr00000000${info.retry}`
  const video = await (await request.post('/api/v1/videos', { data: { url: `https://youtu.be/${externalID}` } })).json()
  const url = `/api/v1/videos/${video.id}/sources/${video.sources[0].id}/transcript`
  let posts = 0
  page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/transcript')) posts++ })
  await page.goto(`/videos/${video.id}`)
  await expect(page.getByText('Aucune transcription enregistrée localement.')).toBeVisible()
  expect(posts).toBe(0)
  await page.getByRole('button', { name: 'Récupérer la transcription', exact: true }).click()
  await expect(page.getByLabel('Texte de la transcription')).toContainText('Bonjour le monde.')
  await expect(page.locator('.transcript-block')).toHaveCount(2)
  const stored = await (await request.get(url)).json()
  expect(stored.language).toBe('fr')
  expect(stored.items[0]).toEqual({ start_ms: 2960, text: 'Bon' })
  await expect(page.getByLabel('Intervalle')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.transcript-block')).toHaveCount(2)
  expect(posts).toBe(1)
  await page.getByRole('button', { name: 'Actualiser la transcription', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Actualiser la transcription', exact: true })).toBeEnabled()
  expect(posts).toBe(2)
})

test('acquiert la piste en-orig pour un audio en-US via Go et SQLite', async ({ page, request }, info) => {
  const video = await (await request.post('/api/v1/videos', {
    data: { url: `https://youtu.be/tr-region0${info.retry}` },
  })).json()
  const url = `/api/v1/videos/${video.id}/sources/${video.sources[0].id}/transcript`
  await page.goto(`/videos/${video.id}`)
  await page.getByRole('button', { name: 'Récupérer la transcription', exact: true }).click()
  await expect(page.getByLabel('Texte de la transcription')).toContainText('Bonjour le monde.')
  expect((await (await request.get(url)).json()).language).toBe('en')
  await expect(page.getByRole('heading', { name: 'Transcription · EN · automatique' })).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('Texte de la transcription')).toContainText('Bonjour le monde.')
})

test('signale une ambiguïté réelle sans acquisition ni relecture automatiques', async ({ page, request }, info) => {
  const video = await (await request.post('/api/v1/videos', {
    data: { url: `https://youtu.be/tr-ambigu0${info.retry}` },
  })).json()
  let reads = 0
  let posts = 0
  page.on('request', req => {
    if (req.url().endsWith('/transcript')) {
      if (req.method() === 'GET') reads++
      if (req.method() === 'POST') posts++
    }
  })
  await page.goto(`/videos/${video.id}`)
  await page.getByRole('button', { name: 'Récupérer la transcription', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Plusieurs transcriptions automatiques originales')
  expect(reads).toBe(1)
  expect(posts).toBe(1)
  const url = `/api/v1/videos/${video.id}/sources/${video.sources[0].id}/transcript`
  expect((await request.get(url)).status()).toBe(404)
})

for (const [code, status, message] of [
  ['transcript_not_available', 404, 'Aucune transcription automatique originale'],
  ['transcript_selection_ambiguous', 409, 'Plusieurs transcriptions automatiques originales'],
  ['transcript_fetch_failed', 502, 'auprès de YouTube'],
  ['transcript_fetch_timeout', 504, 'délai de récupération'],
  ['internal_error', 500, 'erreur interne'],
] as const) {
  test(`conserve le contenu pendant et après ${code}`, async ({ page }) => {
    await page.route('**/api/v1/videos/42', route => route.fulfill({ json: {
      id: 42, created_at: '2026-10-12', tags: [], person_ids: [],
      sources: [{ id: 17, provider: 'youtube', external_id: 'abcdefghijk', title: 'Test' }],
    } }))
    let release!: () => void
    let reads = 0
    const pending = new Promise<void>(resolve => { release = resolve })
    await page.route('**/transcript', async route => {
      if (route.request().method() === 'POST') {
        await pending
        await route.fulfill({ status, json: { error: { code } } })
      } else {
        reads++
        await route.fulfill({ json: {
          language: 'fr', provenance: 'youtube_auto', last_fetched_at: '2026-10-12T10:00:00Z',
          items: [{ start_ms: 1234, text: 'Texte conservé' }],
        } })
      }
    })
    await page.goto('/videos/42')
    await expect(page.getByText('Texte conservé', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Actualiser la transcription', exact: true }).click()
    await expect(page.getByText('Actualisation en cours…')).toBeVisible()
    await expect(page.getByText('Texte conservé', { exact: true })).toBeVisible()
    release()
    await expect(page.getByRole('alert')).toContainText(message)
    await expect(page.locator('.transcript-acquisition.failure')).toBeVisible()
    await expect(page.getByText('Texte conservé', { exact: true })).toBeVisible()
    expect(reads).toBe(1)
  })
}

test('lecture locale en échec distincte de l’absence, puis reprise sans acquisition', async ({ page }) => {
  await mockVideo(page)
  let broken = true
  let posts = 0
  await page.route('**/transcript', route => {
    if (route.request().method() === 'POST') posts++
    return route.fulfill(broken
      ? { status: 500, json: { error: { code: 'internal_error' } } }
      : { json: localTranscript })
  })
  await page.goto('/videos/42')
  await expect(page.getByRole('alert')).toContainText('Impossible de lire la transcription locale')
  await expect(page.getByText('Aucune transcription enregistrée localement.')).toHaveCount(0)
  broken = false
  await page.getByRole('button', { name: 'Relire la transcription locale' }).click()
  await expect(page.getByText('Contenu enregistré', { exact: true })).toBeVisible()
  expect(posts).toBe(0)
})

test('réponse POST perdue : retrouve le contenu local sans relance distante', async ({ page }) => {
  await mockVideo(page)
  let saved = false
  let posts = 0
  await page.route('**/transcript', route => {
    if (route.request().method() === 'POST') {
      posts++; saved = true
      return route.abort('failed')
    }
    return route.fulfill(saved ? { json: localTranscript }
      : { status: 404, json: { error: { code: 'transcript_not_found' } } })
  })
  await page.goto('/videos/42')
  await expect(page.getByRole('button', { name: 'Récupérer la transcription', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Récupérer la transcription', exact: true }).click()
  await expect(page.getByText('Contenu enregistré', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('l’actualisation n’est pas confirmée')
  expect(posts).toBe(1)
})

test('réponse tardive d’une autre fiche ignorée pendant une acquisition', async ({ page }) => {
  await mockVideo(page)
  await mockVideo(page, 43)
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let posts = 0
  await page.route('**/transcript', async route => {
    if (route.request().method() === 'POST') {
      posts++
      await pending
      await route.fulfill({ json: { ...localTranscript, items: [{ start_ms: 0, text: 'Ancien résultat' }] } })
    } else await route.fulfill(route.request().url().includes('/videos/43/')
      ? { json: localTranscript }
      : { status: 404, json: { error: { code: 'transcript_not_found' } } })
  })
  await page.goto('/videos/42')
  await page.getByRole('button', { name: 'Récupérer la transcription', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Récupérer la transcription', exact: true })).toBeDisabled()
  await page.getByRole('link', { name: 'Sillage, accueil' }).click()
  await page.goto('/videos/43')
  await expect(page.getByText('Contenu enregistré')).toBeVisible()
  release()
  await expect(page.getByText('Ancien résultat')).toHaveCount(0)
  await expect(page.locator('.transcript-acquisition.success, .transcript-acquisition.failure')).toHaveCount(0)
  expect(posts).toBe(1)
})


// Ces scénarios isolent le lecteur/transcript : la source simulée n'existe pas en SQLite.
test.beforeEach(async ({ page }) => {
  await page.route('**/download', route => route.fulfill({
    json: { status: 'not_downloaded', media_file: null, error: null },
  }))
})

for (const hasContent of [false, true]) {
  for (const outcome of ['success', 'failure'] as const) {
    test(`retour d’acquisition cinq secondes : contenu ${hasContent}, ${outcome}`, async ({ page }) => {
      await mockVideo(page)
      let release!: () => void
      const pending = new Promise<void>(resolve => { release = resolve })
      let posts = 0
      await page.route('**/transcript', async route => {
        if (route.request().method() === 'POST') {
          posts++
          await pending
          return route.fulfill(outcome === 'success' ? { json: localTranscript }
            : { status: 502, json: { error: { code: 'transcript_fetch_failed' } } })
        }
        return route.fulfill(hasContent ? { json: localTranscript }
          : { status: 404, json: { error: { code: 'transcript_not_found' } } })
      })
      await page.goto('/videos/42')
      const command = page.locator('.transcript-acquisition')
      await expect(command).toBeEnabled()
      await expect(command).not.toHaveClass(/success|failure|progress/)
      await page.clock.install()
      await page.clock.pauseAt(new Date(Date.now() + 1000))
      const initialBox = await command.boundingBox()
      await command.focus()
      await page.keyboard.press('Enter')
      await expect(command).toHaveClass(/progress/)
      await expect(command).toHaveAttribute('aria-busy', 'true')
      await expect(command).toHaveAccessibleDescription(/Acquisition en cours/)
      expect(await command.boundingBox()).toEqual(initialBox)
      if (hasContent) await expect(page.getByText('Contenu enregistré', { exact: true })).toBeVisible()
      release()
      await expect(command).toHaveClass(new RegExp(outcome))
      await expect(command).toBeEnabled()
      await expect(command).toHaveAttribute('aria-busy', 'false')
      await expect(command).toHaveAccessibleDescription(outcome === 'success' ? /confirmée/ : /Échec/)
      if (outcome === 'success') await expect(page.getByRole('status').filter({ hasText: 'Acquisition de la transcription confirmée.' })).toBeAttached()
      const completedBox = await command.boundingBox()
      if (hasContent) expect(completedBox).toEqual(initialBox)
      await page.clock.runFor(4900)
      await expect(command).toHaveClass(new RegExp(outcome))
      await page.clock.runFor(200)
      await expect(command).not.toHaveClass(/success|failure|progress/)
      expect(await command.boundingBox()).toEqual(completedBox)
      await expect(command).toHaveAccessibleName(hasContent || outcome === 'success' ? 'Actualiser la transcription' : 'Récupérer la transcription')
      if (outcome === 'failure') await expect(page.getByRole('alert')).toContainText('auprès de YouTube')
      expect(posts).toBe(1)
    })
  }
}

for (const kind of ['saved', 'absent', 'read-error', 'malformed', 'unknown-error']) {
  test(`réponse incertaine sans symbole de résultat : ${kind}`, async ({ page }) => {
    await mockVideo(page)
    let posts = 0
    let reads = 0
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    await page.route('**/transcript', async route => {
      if (route.request().method() === 'POST') {
        posts++
        if (kind === 'malformed') return route.fulfill({ json: { language: 'fr', items: [] } })
        if (kind === 'unknown-error') return route.fulfill({ status: 503, json: { error: { code: 'unknown' } } })
        return route.abort()
      }
      reads++
      if (reads === 1) return route.fulfill({ json: localTranscript })
      await pending
      return route.fulfill(kind === 'absent'
        ? { status: 404, json: { error: { code: 'transcript_not_found' } } }
        : kind === 'read-error' ? { status: 500, json: { error: { code: 'internal_error' } } }
        : { json: localTranscript })
    })
    await page.goto('/videos/42')
    const command = page.locator('.transcript-acquisition')
    await expect(command).toBeEnabled()
    await command.click()
    await expect(page.getByText('Résultat incertain : vérification de la transcription locale…')).toBeVisible()
    await expect(command).toHaveClass(/progress/)
    await expect(page.getByText('Contenu enregistré', { exact: true })).toBeVisible()
    release()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(command).toBeEnabled()
    await expect(command).not.toHaveClass(/success|failure|progress/)
    await expect(page.getByRole('button', { name: 'Relire la transcription locale' })).toBeVisible()
    expect(posts).toBe(1)
    expect(reads).toBe(2)
  })
}

test('lecture locale et nouvelle action ne réutilisent aucun ancien retour', async ({ page }) => {
  await mockVideo(page)
  let reads = 0
  let posts = 0
  let release!: () => void
  let pending = new Promise<void>(resolve => { release = resolve })
  await page.route('**/transcript', async route => {
    if (route.request().method() === 'POST') {
      posts++
      if (posts === 1) return route.fulfill({ status: 502, json: { error: { code: 'transcript_fetch_failed' } } })
      await pending
      return route.fulfill({ json: localTranscript })
    }
    reads++
    if (reads === 1) await pending
    return route.fulfill({ json: localTranscript })
  })
  await page.goto('/videos/42')
  const command = page.locator('.transcript-acquisition')
  await expect(page.getByText('Chargement de la transcription locale…')).toBeVisible()
  await expect(command).toBeDisabled()
  await expect(command).not.toHaveClass(/success|failure|progress/)
  release()
  await expect(command).toBeEnabled()
  await expect(command).not.toHaveClass(/success|failure|progress/)
  await command.click()
  await expect(command).toHaveClass(/failure/)
  await page.getByRole('button', { name: 'Relire la transcription locale' }).click()
  await expect(command).toBeEnabled()
  await expect(command).not.toHaveClass(/success|failure|progress/)
  await command.click()
  await expect(command).toHaveClass(/success/)
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  pending = new Promise<void>(resolve => { release = resolve })
  await command.click()
  await expect(command).toHaveClass(/progress/)
  await expect(command).not.toHaveClass(/success|failure/)
  await page.clock.runFor(5100)
  release()
  await expect(command).toHaveClass(/success/)
  await page.clock.runFor(4900)
  await expect(command).toHaveClass(/success/)
  await page.clock.runFor(200)
  await expect(command).not.toHaveClass(/success|failure|progress/)
  expect(posts).toBe(3)
  expect(reads).toBe(2)
})

test('rendu stable des retours en clair/sombre, desktop/mobile et mouvement réduit', async ({ page }, info) => {
  await mockVideo(page)
  let outcome = 'success'
  let release!: () => void
  let pending = Promise.resolve()
  await page.route('**/transcript', async route => {
    if (route.request().method() === 'POST') {
      await pending
      return route.fulfill(outcome === 'success' ? { json: localTranscript }
        : { status: 502, json: { error: { code: 'transcript_fetch_failed' } } })
    }
    return route.fulfill({ json: localTranscript })
  })
  await page.goto('/videos/42')
  const command = page.locator('.transcript-acquisition')
  await expect(command).toBeEnabled()
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  for (const width of [1440, 375, 320]) {
    await page.setViewportSize({ width, height: 900 })
    for (const theme of ['light', 'dark']) {
      await selectTheme(page, theme)
      await command.scrollIntoViewIfNeeded()
      const initial = await documentBox(command)
      const heading = page.locator('.transcript-heading')
      const initialHeading = await documentBox(heading)
      for (const result of ['success', 'failure']) {
        outcome = result
        pending = new Promise<void>(resolve => { release = resolve })
        await command.click()
        await expect(command).toHaveClass(/progress/)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await expect(command.locator('svg')).toHaveCSS('animation-name', 'none')
        await page.emulateMedia({ reducedMotion: 'no-preference' })
        await expect(command.locator('svg')).toHaveCSS('animation-name', 'capture-spin')
        await heading.screenshot({ path: info.outputPath(`transcript-${width}-${theme}-progress-${result}.png`) })
        release()
        await expect(command).toHaveClass(new RegExp(result))
        expect(await documentBox(command)).toEqual(initial)
        expect(await documentBox(heading)).toEqual(initialHeading)
        await heading.screenshot({ path: info.outputPath(`transcript-${width}-${theme}-${result}.png`) })
        await page.clock.runFor(5100)
        await expect(command).not.toHaveClass(/success|failure|progress/)
        expect(await documentBox(command)).toEqual(initial)
        expect(initial!.width).toBe(40)
        expect(initial!.height).toBe(40)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      }
    }
  }
})
