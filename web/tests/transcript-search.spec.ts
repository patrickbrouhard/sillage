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
  await expect(page.getByRole('searchbox')).toBeVisible()
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
  expect(findTranscriptMatches('a  b', 'a b')).toEqual([])
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
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('0 / 0')
  await expect(page.getByRole('button', { name: 'Occurrence suivante' })).toBeDisabled()
  await search.fill('bonjour')
  await page.getByRole('button', { name: 'Occurrence suivante' }).click()
  await page.getByRole('button', { name: 'Actualiser', exact: true }).click()
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
  await page.getByRole('button', { name: 'Masquer le lecteur' }).click()
  await expect(page.getByRole('button', { name: 'Afficher le lecteur' })).toBeVisible()
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
  await page.getByRole('link', { name: 'Revenir à la bibliothèque' }).click()
  await page.getByRole('link', { name: 'Consulter : Autre vidéo' }).click()
  await expect(page.getByRole('searchbox')).toHaveValue('')
  await expect(page.locator('mark')).toHaveCount(0)
  await page.getByRole('searchbox').fill('monde')
  await page.goBack()
  await page.goBack()
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
  await page.getByRole('button', { name: 'Actualiser', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('2 / 2')
  await expect(page.locator('mark[aria-current=true]')).toHaveText(['BONJOUR'])
})


test('une occurrence unique peut être retrouvée après un défilement manuel', async ({ page }) => {
  await prepare(page)
  await page.getByRole('searchbox').fill('  Bonjour')
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('1 / 1')
  const panel = page.locator('.transcript-content')
  await panel.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect(page.locator('mark')).not.toBeInViewport()
  await page.getByRole('button', { name: 'Occurrence suivante' }).click()
  await expect(page.locator('mark')).toBeInViewport()
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
  await page.getByRole('button', { name: 'Actualiser', exact: true }).click()
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('0 / 0')
  await expect(page.getByRole('searchbox')).toHaveValue('bonjour')
  await expect(page.locator('mark')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Occurrence suivante' })).toBeDisabled()
  await page.getByRole('searchbox').fill('nouveau')
  await expect(page.getByLabel('Occurrences', { exact: true })).toHaveText('1 / 1')
  await expect(page.locator('mark')).toHaveText(['Nouveau'])
})
