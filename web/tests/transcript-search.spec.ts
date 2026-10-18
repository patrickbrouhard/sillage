import { expect, test } from './fixtures'
import type { Page } from '@playwright/test'
import { findTranscriptMatches, highlightTranscript } from '../src/transcriptSearch'
import { groupTranscript } from '../src/transcriptPresentation'

const items = [
  { start_ms: 1000, text: '  Bon' },
  { start_ms: 2000, text: 'jour le' },
  { start_ms: 10000, text: ' mon' },
  { start_ms: 20000, text: 'de.\n' },
  ...Array.from({ length: 45 }, (_, i) => ({ start_ms: 30000 + i * 10000, text: 'Du texte intermédiaire. ' })),
  { start_ms: 500000, text: 'BONJOUR LE MONDE.' },
]

/** Isole les données de recherche tout en conservant le vrai workspace et le lecteur simulé. */
async function prepare(page: Page) {
  await page.route('**/api/v1/videos/42', route => route.fulfill({ json: {
    id: 42, created_at: '2026-10-13', tags: [], person_ids: [],
    sources: [{ id: 52, provider: 'youtube', external_id: 'abcdefghijk', title: 'Recherche' }],
  } }))
  await page.route('**/api/v1/videos/42/note', route => route.fulfill({
    status: 404, json: { error: { code: 'note_not_found' } },
  }))
  await page.route('**/transcript', route => route.fulfill({ json: {
    language: 'fr', provenance: 'youtube_auto', last_fetched_at: '2026-10-13T10:00:00Z', items,
  } }))
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/videos/42')
  await page.getByRole('button', { name: 'Rechercher dans la transcription', exact: true }).click()
  await expect(page.getByRole('searchbox')).toBeFocused()
  await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toBeVisible()
  await page.locator('.video-workspace').evaluate(element => element.scrollIntoView({ block: 'start' }))
  await expect.poll(() => page.evaluate(() => window.youtubeTest?.players.length)).toBe(1)
}

test('recherche continue, littérale et Unicode avec indices exacts et espaces conservés', () => {
  const blocks = groupTranscript(items, 10)
  const text = items.map(item => item.text).join('')
  const copy = structuredClone(items)
  const matches = findTranscriptMatches(text, 'bonjour le monde')
  expect(matches).toHaveLength(2)
  const parts = highlightTranscript(blocks, matches)
  expect(parts.flat().map(part => part.text).join('')).toBe(text)
  expect(parts.flat().filter(part => part.matchIndex === 0).map(part => part.text).join('')).toBe('Bonjour le monde')
  expect(parts.filter(block => block.some(part => part.matchIndex === 0))).toHaveLength(3)
  expect(items).toEqual(copy)
  expect(findTranscriptMatches('😀 ÉTÉ [a.*] İ fin', '[a.*]')).toEqual([{ start: 7, end: 12 }])
  expect(findTranscriptMatches('😀 ÉTÉ [a.*] İ fin', 'été')).toEqual([{ start: 3, end: 6 }])
  expect(findTranscriptMatches('İ fin', 'fin')).toEqual([{ start: 2, end: 5 }])
  expect(findTranscriptMatches('a  b', 'a b')).toEqual([{ start: 0, end: 4 }])
  expect(findTranscriptMatches('aaaa', 'aa')).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }])
  expect(findTranscriptMatches('texte', '')).toEqual([])
})

test('surligne à travers les blocs, boucle et défile sans réseau ni commande lecteur', async ({ page }, info) => {
  await prepare(page)
  await page.evaluate(() => {
    const player = window.youtubeTest.players[0]
    player.position = 123
    player.emitState(1)
  })
  const requests: string[] = []
  page.on('request', request => { if (request.url().includes('/api/')) requests.push(request.url()) })
  await page.getByRole('searchbox').fill('bonjour le monde')
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('1 / 2')
  await expect(page.locator('mark')).toHaveCount(4)
  await expect(page.locator('mark[aria-current=true]')).toHaveText(['Bonjour le', ' mon', 'de'])
  const text = await page.locator('.transcript-block p').allTextContents()
  expect(text.join('')).toBe(items.map(item => item.text).join(''))
  const pageScroll = await page.evaluate(() => window.scrollY)
  await page.getByRole('button', { name: 'Occurrence précédente' }).click()
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('2 / 2')
  await expect(page.locator('mark[aria-current=true]')).toHaveText(['BONJOUR LE MONDE'])
  expect(await page.locator('.transcript-content').evaluate(element => element.scrollTop)).toBeGreaterThan(500)
  expect(await page.evaluate(() => window.scrollY)).toBe(pageScroll)
  await page.getByRole('button', { name: 'Occurrence suivante' }).click()
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('1 / 2')
  await page.getByRole('button', { name: 'Occurrence suivante' }).click()
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('2 / 2')
  expect(await page.evaluate(() => {
    const p = window.youtubeTest.players[0]
    return { state: p.state, position: p.position, calls: p.navigationCalls, pauses: p.pauseCalls }
  })).toEqual({ state: 1, position: 123, calls: [], pauses: 0 })
  expect(requests).toEqual([])
  await expect(page.locator('mark[aria-current=true]')).toBeInViewport()
  await page.screenshot({ path: info.outputPath('search-desktop.png') })
  await page.getByLabel('Thème', { exact: true }).selectOption('dark')
  await page.locator('.video-workspace').evaluate(element => element.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: info.outputPath('search-dark.png') })
  // Le timestamp conserve son chemin explicite vers le lecteur.
  await page.locator('.transcript-time').first().click()
  expect(await page.evaluate(() => window.youtubeTest.players[0].navigationCalls)).toHaveLength(1)
})

test('recherche vide, aucun résultat, effacement et actualisation recalculent la sélection', async ({ page }) => {
  await prepare(page)
  const search = page.getByRole('searchbox')
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('')
  await expect(page.getByRole('button', { name: 'Occurrence suivante' })).toBeDisabled()
  await search.fill('bonjour')
  await page.getByRole('button', { name: 'Occurrence suivante' }).click()
  await page.getByRole('button', { name: 'Actualiser la transcription', exact: true }).click()
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('1 / 2')
  await search.fill('absent')
  await expect(page.locator('mark')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Occurrence précédente' })).toBeDisabled()
  await search.fill('monde')
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('1 / 2')
  await search.fill('')
  await expect(page.locator('mark')).toHaveCount(0)
})

test('le lecteur masqué reste masqué pendant la recherche sur écran étroit', async ({ page }) => {
  await prepare(page)
  await page.getByRole('button', { name: 'Masquer la vidéo' }).click()
  await expect(page.getByRole('button', { name: 'Afficher la vidéo' })).toBeVisible()
  await page.setViewportSize({ width: 375, height: 812 })
  await page.getByRole('searchbox').fill('bonjour le monde')
  await page.getByRole('button', { name: 'Occurrence précédente' }).click()
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('2 / 2')
  await expect(page.locator('mark[aria-current=true]')).toBeInViewport()
  await expect(page.locator('.youtube-frame iframe')).not.toBeVisible()
  expect(await page.evaluate(() => window.youtubeTest.players[0].navigationCalls)).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('changer de vidéo et de source par navigation interne réinitialise la recherche', async ({ page }) => {
  await prepare(page)
  const other = {
    id: 43, created_at: '2026-10-13', tags: [], person_ids: [],
    sources: [{ id: 53, provider: 'youtube', external_id: 'bcdefghijkl', title: 'Autre vidéo' }],
  }
  await page.route('**/api/v1/videos', route => route.fulfill({ json: { videos: [other] } }))
  await page.route('**/api/v1/videos/43', route => route.fulfill({ json: other }))
  await page.route('**/api/v1/videos/43/note', route => route.fulfill({
    status: 404, json: { error: { code: 'note_not_found' } },
  }))
  await page.getByRole('searchbox').fill('bonjour')
  await page.getByRole('link', { name: 'Sillage, accueil' }).click()
  await page.getByRole('link', { name: 'Consulter : Autre vidéo' }).click()
  await expect(page.getByRole('button', { name: 'Rechercher dans la transcription', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await page.getByRole('button', { name: 'Rechercher dans la transcription', exact: true }).click()
  await expect(page.getByRole('searchbox')).toHaveValue('')
  await expect(page.locator('mark')).toHaveCount(0)
  await page.getByRole('searchbox').fill('monde')
  await page.goBack()
  await page.goBack()
  await expect(page.getByRole('button', { name: 'Rechercher dans la transcription', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await page.getByRole('button', { name: 'Rechercher dans la transcription', exact: true }).click()
  await expect(page.getByRole('searchbox')).toHaveValue('')
  await expect(page.locator('mark')).toHaveCount(0)
})

test('la recherche reste utilisable sans lecteur prêt, sans commande différée', async ({ page }) => {
  await page.addInitScript(() => {
    window.youtubeTest = { players: [], autoReady: false, confirmPause: true }
  })
  await prepare(page)
  await page.getByRole('searchbox').fill('bonjour')
  await page.getByRole('button', { name: 'Occurrence suivante' }).click()
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('2 / 2')
  await page.evaluate(() => {
    const player = window.youtubeTest.players[0]
    player.options.events.onReady({ target: player })
  })
  expect(await page.evaluate(() => window.youtubeTest.players[0].navigationCalls)).toEqual([])
})

test('un échec d’actualisation conserve la recherche et sa sélection', async ({ page }) => {
  await prepare(page)
  await page.getByRole('searchbox').fill('bonjour')
  await page.getByRole('button', { name: 'Occurrence suivante' }).click()
  await page.route('**/transcript', route => route.fulfill({
    status: 502, json: { error: { code: 'transcript_fetch_failed' } },
  }))
  await page.getByRole('button', { name: 'Actualiser la transcription', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('2 / 2')
  await expect(page.locator('mark[aria-current=true]')).toHaveText(['BONJOUR'])
})


test('une occurrence unique peut être retrouvée après un défilement manuel', async ({ page }) => {
  await prepare(page)
  await page.getByRole('searchbox').fill('bonjour le monde. Du')
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('1 / 1')
  const panel = page.locator('.transcript-content')
  await panel.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect(page.locator('mark').first()).not.toBeInViewport()
  await page.getByRole('button', { name: 'Occurrence suivante' }).click()
  await expect(page.locator('mark').first()).toBeInViewport()
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('1 / 1')
})

test('une actualisation remplace les occurrences disparues sans perdre la requête', async ({ page }) => {
  await prepare(page)
  await page.getByRole('searchbox').fill('bonjour')
  await page.getByRole('button', { name: 'Occurrence suivante' }).click()
  await page.route('**/transcript', route => route.fulfill({ json: {
    language: 'fr', provenance: 'youtube_auto', last_fetched_at: '2026-10-13T11:00:00Z',
    items: [{ start_ms: 0, text: 'Nouveau contenu' }],
  } }))
  await page.getByRole('button', { name: 'Actualiser la transcription', exact: true }).click()
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('Aucun résultat')
  await expect(page.getByRole('searchbox')).toHaveValue('bonjour')
  await expect(page.locator('mark')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Occurrence suivante' })).toBeDisabled()
  await page.getByRole('searchbox').fill('nouveau')
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('1 / 1')
  await expect(page.locator('mark')).toHaveText(['Nouveau'])
})


test('Entrée parcourt cinq occurrences en boucle sans quitter le champ ni commander le lecteur', async ({ page }) => {
  await prepare(page)
  await page.route('**/transcript', route => route.fulfill({ json: {
    language: 'en', provenance: 'youtube_auto', last_fetched_at: '2026-10-13T11:00:00Z',
    items: [{ start_ms: 0, text: 'stuff stuff stuff stuff stuff' }],
  } }))
  await page.getByRole('button', { name: 'Actualiser la transcription', exact: true }).click()
  await expect(page.locator('.transcript-block')).toHaveCount(1)
  const search = page.getByRole('searchbox')
  await search.fill('stuff')
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('1 / 5')
  for (const index of [2, 3, 4, 5, 1]) {
    await search.press('Enter')
    await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText(index + ' / 5')
    await expect(search).toBeFocused()
  }
  await search.fill('absent')
  await search.press('Enter')
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('Aucun résultat')
  expect(await page.evaluate(() => window.youtubeTest.players[0].navigationCalls)).toEqual([])
})

test('retrouve thought about séparé par un saut source entre deux blocs', async ({ page }) => {
  await prepare(page)
  const fragments = [
    { start_ms: 39920, text: ' thought' },
    { start_ms: 40110, text: '\n' },
    { start_ms: 40120, text: 'about' },
    { start_ms: 40360, text: ' it' },
  ]
  await page.route('**/transcript', route => route.fulfill({ json: {
    language: 'en', provenance: 'youtube_auto', last_fetched_at: '2026-10-13T11:00:00Z',
    items: fragments,
  } }))
  await page.getByRole('button', { name: 'Actualiser la transcription', exact: true }).click()
  await expect(page.locator('.transcript-block')).toHaveCount(2)
  await page.getByRole('searchbox').fill('thought about')
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('1 / 1')
  expect(await page.locator('mark').allTextContents()).toEqual(['thought', '\nabout'])
  expect((await page.locator('.transcript-block p').allTextContents()).join(''))
    .toBe(fragments.map(item => item.text).join(''))
})

test('les blancs équivalents conservent les indices source sans inventer de séparateurs', () => {
  expect(findTranscriptMatches('Thought\r\n  \tabout', 'thought about')).toEqual([{ start: 0, end: 17 }])
  expect(findTranscriptMatches('thought about', 'thought\nabout')).toEqual([{ start: 0, end: 13 }])
  expect(findTranscriptMatches('thoughtabout', 'thought about')).toEqual([])
  expect(findTranscriptMatches('été', 'ete')).toEqual([])
})


// Ces scénarios isolent le lecteur/transcript : la source simulée n'existe pas en SQLite.
test.beforeEach(async ({ page }) => {
  await page.route('**/download', route => route.fulfill({
    json: { status: 'not_downloaded', media_file: null, error: null },
  }))
})


test('replier conserve la recherche et le résultat actif sans commander le lecteur', async ({ page }) => {
  await prepare(page)
  const search = page.getByRole('searchbox')
  const toggle = page.getByRole('button', { name: 'Rechercher dans la transcription', exact: true })
  await search.fill('bonjour')
  await page.getByRole('button', { name: 'Occurrence suivante' }).click()
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('2 / 2')
  await search.press('Escape')
  await expect(search).toBeHidden()
  await expect(toggle).toBeFocused()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle).toHaveClass(/search-active/)
  await expect(page.locator('mark')).not.toHaveCount(0)
  await toggle.click()
  await expect(search).toBeFocused()
  await expect(search).toHaveValue('bonjour')
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('2 / 2')
  await page.getByRole('button', { name: 'Effacer la recherche' }).click()
  await expect(search).toBeFocused()
  await expect(search).toHaveValue('')
  await expect(page.locator('mark')).toHaveCount(0)
  await expect(toggle).not.toHaveClass(/search-active/)
  expect(await page.evaluate(() => window.youtubeTest.players[0].navigationCalls)).toEqual([])
})


test('actions compactes : aide au clavier et recherche utilisable sur écran étroit', async ({ page }, info) => {
  await prepare(page)
  await page.getByRole('searchbox').press('Escape')
  const refresh = page.getByRole('button', { name: 'Actualiser la transcription', exact: true })
  await refresh.focus()
  const tooltip = page.getByRole('tooltip').filter({ hasText: 'Acquisition du' })
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toContainText('13/10/2026')
  await refresh.press('Escape')
  await expect(tooltip).toBeHidden()
  for (const width of [1440, 375, 320]) {
    await page.setViewportSize({ width, height: 900 })
    const toggle = page.getByRole('button', { name: 'Rechercher dans la transcription', exact: true })
    await toggle.click()
    await page.getByRole('searchbox').fill('bonjour')
    await expect(page.getByRole('button', { name: 'Occurrence suivante' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath(`transcript-search-${width}.png`) })
    await page.getByRole('searchbox').press('Escape')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  }
})
