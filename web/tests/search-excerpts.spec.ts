import { expect, test } from './fixtures'
import type { Locator, Page } from '@playwright/test'
import { selectTheme } from './navigationHelpers'
import type { SearchResult, SearchSegment } from '../src/searchApi'

/** Fixture d'affichage ; le serveur réel reste couvert séparément par les tests de recherche. */
function item(id: number, excerpt: SearchSegment[]): SearchResult {
  return {
    video: { id, created_at: '2026-01-01T00:00:00Z', person_ids: [], tags: [],
      sources: [{ id, provider: 'youtube', title: 'Vidéo ' + id, external_id: null, canonical_url: null,
        thumbnail_url: null, duration_ms: null, description: null, publisher: { id, name: 'Atelier' } }] },
    source_matches: [{ source_id: id, title: false, description: true, publisher: false }],
    note_excerpt: excerpt,
  }
}

const longExcerpt: SearchSegment[] = [
  { text: 'Attribution avant le corps.\n\n' + 'Un long contexte avant la marque. '.repeat(7), highlight: false },
  { text: 'Café', highlight: true },
  { text: '\n\nListe et code <script>injection()</script> & \"guillemets\" /tmp/fichier ' + 'Contexte après. '.repeat(12), highlight: false },
]

/** Vérifie les boîtes réellement affichées et leurs marques, sans se fier à toBeVisible seul. */
async function expectCompact(row: Locator) {
  const paragraph = row.locator('.search-excerpt:not([aria-hidden])')
  await expect.poll(() => paragraph.evaluate(element => {
    const box = element.getBoundingClientRect()
    const scale = box.width / element.clientWidth
    const lineHeight = parseFloat(getComputedStyle(element).lineHeight) * scale
    const marks = [...element.querySelectorAll('mark')].flatMap(mark => {
      const range = document.createRange()
      range.selectNodeContents(mark)
      return [...range.getClientRects()]
    })
    return {
      twoLines: box.height <= 2 * lineHeight + 1,
      markInside: marks.some(mark => mark.width > 0 && mark.height > 0 &&
        mark.top >= box.top - 1 && mark.bottom <= box.bottom + 1 &&
        mark.left >= box.left - 1 && mark.right <= box.right + 1),
    }
  })).toEqual({ twoLines: true, markInside: true })
}

/** Utilise seulement les réponses de recherche ; toute lecture de note serait observée par le test. */
async function mock(page: Page, results: SearchResult[], total = results.length) {
  await page.route('**/api/v1/search?**', route => route.fulfill({
    json: { results, total, page: 1, has_more: false },
  }))
}

test('extrait court continu : blancs intersegments, caractères littéraux et aucun bouton', async ({ page }) => {
  await mock(page, [item(1, [
    { text: 'Attribution\n ', highlight: false },
    { text: '\t Café', highlight: true },
    { text: '\n\ncorps\t', highlight: false },
    { text: ' \n<code> & fin', highlight: false },
  ])])
  await page.goto('/search?q=cafe')
  const row = page.locator('.search-result')
  await expect(row.locator('.search-excerpt:not([aria-hidden])')).toHaveText('Attribution Café corps <code> & fin')
  await expect(row.getByRole('button', { name: 'Voir plus' })).toHaveCount(0)
  await expectCompact(row)
  await expect(page.locator('.source-label, .page-heading, .eyebrow, .intro')).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Résultats pour « cafe »')
  await expect(page.locator('.search-count')).toHaveCSS('border-top-width', '0px')
  await row.getByRole('button', { name: 'Pourquoi cette vidéo apparaît' }).click()
  await expect(page.getByRole('region', { name: 'Explications de la recherche' })).toContainText('description')
})

for (const width of [1440, 375, 320]) {
  test('extrait tardif, dépliage local, focus et géométrie à ' + width, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 })
    const requests: string[] = []
    page.on('request', request => { if (request.url().includes('/api/')) requests.push(request.url()) })
    await mock(page, [item(1, longExcerpt)])
    await page.goto('/search?q=cafe')
    const row = page.locator('.search-result')
    const paragraph = row.locator('.search-excerpt:not([aria-hidden])')
    const button = row.locator('.search-excerpt-toggle')
    await expect(button).toBeVisible()
    await expectCompact(row)
    await expect(paragraph.locator('mark')).toHaveText('Café')
    await expect(paragraph).toContainText('…')
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(await button.getAttribute('aria-controls')).toBe(await paragraph.getAttribute('id'))
    const before = [...requests]
    await button.focus()
    await button.press('Enter')
    await expect(button).toHaveAccessibleName('Réduire')
    await expect(button).toBeFocused()
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    await expect(paragraph).toHaveText(longExcerpt.map(segment => segment.text).join('').replace(/\s+/g, ' ').trim())
    await expect(paragraph.locator('script, code')).toHaveCount(0)
    await expect(paragraph.locator('mark')).toHaveText('Café')
    await button.press('Space')
    await expect(button).toHaveAccessibleName('Voir plus')
    await expect(button).toBeFocused()
    await expectCompact(row)
    expect(requests).toEqual(before)
    for (const theme of ['light', 'dark']) {
      await selectTheme(page, theme)
      await expectCompact(row)
      await page.screenshot({ path: info.outputPath('excerpt-' + theme + '.png'), fullPage: true })
    }
  })
}

test('résultats indépendants et état remis à zéro après remplacement et nouvelle recherche', async ({ page }) => {
  let replacement = false
  await page.route('**/api/v1/search?**', route => {
    const results = replacement ? [item(1, [{ text: 'Nouveau Café', highlight: true }])]
      : [item(1, longExcerpt), item(2, longExcerpt)]
    return route.fulfill({ json: { results, page: 1, has_more: false, total: results.length } })
  })
  await page.goto('/search?q=cafe')
  const rows = page.locator('.search-result')
  await rows.nth(0).getByRole('button', { name: 'Voir plus' }).click()
  await expect(rows.nth(0).locator('.search-excerpt-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(rows.nth(1).locator('.search-excerpt-toggle')).toHaveAttribute('aria-expanded', 'false')
  await page.getByRole('searchbox').fill('autre')
  await page.getByRole('searchbox').press('Enter')
  await expect(rows.nth(0).locator('.search-excerpt-toggle')).toHaveAttribute('aria-expanded', 'false')
  await rows.nth(0).locator('.search-excerpt-toggle').click()
  replacement = true
  await page.getByRole('searchbox').press('Enter')
  await expect(rows).toHaveCount(1)
  await expect(rows.locator('.search-excerpt:not([aria-hidden])')).toHaveText('Nouveau Café')
  await expect(rows.locator('.search-excerpt-toggle')).toHaveCount(0)
})

test('recalcul de largeur, taille de texte, zoom et token exceptionnellement long', async ({ page }, info) => {
  await mock(page, [item(1, longExcerpt), item(2, [{ text: 'préface '.repeat(20), highlight: false }, { text: '漢'.repeat(550), highlight: true }])])
  await page.goto('/search?q=cafe')
  for (const width of [1440, 375, 768, 320]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const row of await page.locator('.search-result').all()) await expectCompact(row)
  }
  await page.addStyleTag({ content: '.search-excerpt { font-size: 28px; }' })
  for (const row of await page.locator('.search-result').all()) await expectCompact(row)
  await page.screenshot({ path: info.outputPath('excerpt-large-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.evaluate(() => { document.body.style.zoom = '2' })
  for (const row of await page.locator('.search-result').all()) await expectCompact(row)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('excerpt-zoom.png'), fullPage: true })
  // Observer les sondes au repos détecte une boucle de mesure sans imposer une durée de calcul.
  const mutations = await page.evaluate(async () => {
    let changes = 0
    const observer = new MutationObserver(records => { changes += records.length })
    document.querySelectorAll('.search-excerpt-measure').forEach(probe => observer.observe(probe, { childList: true }))
    await new Promise(resolve => setTimeout(resolve, 200))
    observer.disconnect()
    return changes
  })
  expect(mutations).toBe(0)
})

test('agrandir la largeur supprime Voir plus lorsque tout tient effectivement', async ({ page }) => {
  await mock(page, [item(1, [{ text: 'contexte '.repeat(10), highlight: false }, { text: 'Café', highlight: true }])])
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto('/search?q=cafe')
  const row = page.locator('.search-result')
  await expect(row.locator('.search-excerpt-toggle')).toBeVisible()
  await page.setViewportSize({ width: 1920, height: 900 })
  await expect(row.locator('.search-excerpt-toggle')).toHaveCount(0)
  await expectCompact(row)
})

test('totaux globaux sur toutes les pages et page vide distinguée', async ({ page }) => {
  await page.route('**/api/v1/search?**', route => {
    const number = Number(new URL(route.request().url()).searchParams.get('page') || 1)
    const results = number === 4 ? [] : [item(1, [])]
    return route.fulfill({ json: { results, total: 41, page: number, has_more: number < 3 } })
  })
  await page.goto('/search?q=alpha')
  await expect(page.locator('.search-count')).toHaveText('41 vidéos correspondantes')
  await page.getByRole('link', { name: 'Page suivante' }).click()
  await expect(page.locator('.search-count')).toHaveText('41 vidéos correspondantes')
  await page.goto('/search?q=alpha&page=4')
  await expect(page.locator('.search-count')).toHaveText('41 vidéos correspondantes')
  await expect(page.getByRole('heading', { name: 'Aucun résultat sur cette page', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Aucun résultat', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Page précédente' })).toBeVisible()
})

for (const total of [undefined, -1, 1.5, '3', null]) {
  test('total invalide refusé sans repli : ' + total, async ({ page }) => {
    await page.route('**/api/v1/search?**', route => route.fulfill({
      json: { results: [item(1, [])], page: 1, has_more: false, total },
    }))
    await page.goto('/search?q=alpha')
    await expect(page.getByRole('alert')).toContainText('réponse de recherche est invalide')
    await expect(page.locator('.search-count')).toHaveCount(0)
  })
}

test('extrait FTS réel de 64 tokens : complet au dépliage, deux lignes au repos', async ({ page, request }) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/tr64excerpt' } })).json()
  const words = Array.from({ length: 64 }, (_, i) => 'contexteparticulierementlong' + i)
  words[30] = 'correspondanceunique64'
  const content = words.join(' ')
  expect(content.length).toBeGreaterThan(600)
  expect((await request.put('/api/v1/videos/' + video.id + '/note', {
    data: { content_md: content, expected_revision: 0 },
  })).ok()).toBe(true)
  await page.setViewportSize({ width: 375, height: 900 })
  await page.goto('/search?q=correspondanceunique64')
  const row = page.locator('.search-result')
  await expectCompact(row)
  const button = row.locator('.search-excerpt-toggle')
  await expect(button).toHaveText('Voir plus')
  const requests: string[] = []
  page.on('request', request => { if (request.url().includes('/api/')) requests.push(request.url()) })
  await button.click()
  await expect(row.locator('.search-excerpt:not([aria-hidden])')).toHaveText(content)
  await expect(button).toHaveText('Réduire')
  await button.click()
  await expectCompact(row)
  expect(requests).toEqual([])
})


test('token géant : contexte borné dès la réponse et dépliage sans charger la note', async ({ page, request }) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trHugeEx001' } })).json()
  const content = 'x'.repeat(1_000_000) + ' correspondancegeanteunique'
  expect((await request.put('/api/v1/videos/' + video.id + '/note', {
    data: { content_md: content, expected_revision: 0 },
  })).ok()).toBe(true)
  const response = await request.get('/api/v1/search?q=correspondancegeanteunique')
  expect(response.ok()).toBe(true)
  const result = (await response.json()).results[0] as SearchResult
  const excerpt = result.note_excerpt.map(segment => segment.text).join('')
  expect([...excerpt].length).toBeLessThanOrEqual(4098)
  expect(excerpt.startsWith('…')).toBe(true)
  expect(excerpt).toContain('correspondancegeanteunique')
  await page.setViewportSize({ width: 375, height: 900 })
  await page.goto('/search?q=correspondancegeanteunique')
  const row = page.locator('.search-result')
  await expectCompact(row)
  const requests: string[] = []
  page.on('request', request => { if (request.url().includes('/api/')) requests.push(request.url()) })
  const button = row.locator('.search-excerpt-toggle')
  await button.click()
  await expect(row.locator('.search-excerpt:not([aria-hidden])')).toHaveText(excerpt)
  await expect(button).toHaveText('Réduire')
  await button.click()
  await expectCompact(row)
  expect(requests).toEqual([])
})
