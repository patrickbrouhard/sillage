import { expect, test } from './fixtures'
import type { SearchResult } from '../src/searchApi'
import { selectTheme } from './navigationHelpers'

test('tag de résultat : bibliothèque complète filtrée, souris, clavier, nouvel onglet et historique', async ({ page, request }) => {
  const query = 'lienspastillerecherche'
  const matching = []
  // Vingt résultats précèdent la dernière vidéo ; seule celle-ci recevra le tag partagé.
  for (let i = 0; i < 21; i++) {
    const response = await request.post('/api/v1/videos', {
      data: { url: 'https://youtu.be/trTag' + String(i).padStart(6, '0') },
    })
    expect(response.ok()).toBe(true)
    const video = await response.json()
    matching.push(video)
    expect((await request.put('/api/v1/videos/' + video.id + '/note', {
      data: { content_md: query, expected_revision: 0 },
    })).ok()).toBe(true)
  }
  const selected = matching[20]
  const unrelated = await (await request.post('/api/v1/videos', {
    data: { url: 'https://youtu.be/trTagOther1' },
  })).json()
  let tagID = 0
  for (const video of [selected, unrelated]) {
    const response = await request.post('/api/v1/videos/' + video.id + '/tags', {
      data: { names: ['Programmation — liens de recherche'] },
    })
    expect(response.ok()).toBe(true)
    const body = await response.json()
    tagID = body.tags.find((tag: { name: string }) => tag.name === 'Programmation — liens de recherche').id
  }

  const searchURL = '/search?' + new URLSearchParams({ q: query, page: '2' })
  const filterURL = '/?tag_id=' + tagID
  await page.goto(searchURL)
  await expect(page.locator('.search-result')).toHaveCount(1)
  await expect(page.getByRole('heading', { level: 2, name: selected.sources[0].title })).toBeVisible()
  const tag = page.locator('.search-result').getByRole('link', { name: 'Programmation — liens de recherche', exact: true })
  await expect(tag).toHaveAttribute('href', filterURL)
  const detailRequests: string[] = []
  page.on('request', request => {
    if (/\/api\/v1\/videos\/\d+$/.test(new URL(request.url()).pathname)) detailRequests.push(request.url())
  })

  // Le padding appartient au lien : le bord intérieur de la pastille est activable.
  await tag.hover()
  await expect(tag).toHaveCSS('text-decoration-line', 'underline')
  await tag.click({ position: { x: 2, y: 2 } })
  await expect(page).toHaveURL(filterURL)
  await expect(page.locator('.video-card')).toHaveCount(2)
  for (const video of [selected, unrelated]) {
    await expect(page.getByRole('heading', { level: 2, name: video.sources[0].title })).toBeVisible()
  }
  await expect(page.getByRole('heading', { level: 2, name: matching[0].sources[0].title })).toHaveCount(0)
  await page.goBack()
  await expect(page).toHaveURL(searchURL)
  await expect(tag).toBeVisible()

  await page.locator('.search-result h2 a').focus()
  await page.keyboard.press('Tab')
  await expect(tag).toBeFocused()
  await expect(tag).toHaveCSS('outline-style', 'solid')
  await expect(tag).toHaveCSS('outline-width', '2px')
  await tag.press('Enter')
  await expect(page).toHaveURL(filterURL)
  await expect(page.locator('.video-card')).toHaveCount(2)
  await page.goBack()
  await expect(page).toHaveURL(searchURL)

  // Le clic milieu conserve le comportement natif du lien sans quitter la recherche.
  const opened = page.context().waitForEvent('page')
  await tag.click({ button: 'middle' })
  const tab = await opened
  await expect(tab).toHaveURL(filterURL)
  await expect(tab.locator('.video-card')).toHaveCount(2)
  await tab.close()
  await expect(page).toHaveURL(searchURL)
  expect(detailRequests).toEqual([])
})

/** Plusieurs groupes de contenu exercent le retour des pastilles et la liste sans bordures. */
function visualResult(id: number): SearchResult {
  return {
    video: {
      id, created_at: '2026-01-01T00:00:00Z', person_ids: [],
      tags: [
        { id: 3, name: 'Programmation' },
        { id: 4, name: 'Architecture et données distribuées' },
        { id: 5, name: 'SansEspace'.repeat(14) },
        { id: 6, name: 'À approfondir' },
      ],
      sources: [
        { id, provider: 'youtube', title: id === 1 ? 'Titre technique ' + 'trèslong'.repeat(25) : 'Autre vidéo ' + id,
          external_id: null, canonical_url: null, thumbnail_url: null, duration_ms: null,
          description: null, publisher: { id: 1, name: 'Atelier technique' } },
        { id: id + 10, provider: 'local', title: 'Source secondaire', external_id: null,
          canonical_url: null, thumbnail_url: null, duration_ms: null, description: 'Description',
          publisher: null },
      ],
    },
    source_matches: [{ source_id: id + 10, title: false, description: true, publisher: false }],
    note_excerpt: [
      { text: 'Un contexte pour comprendre. '.repeat(8), highlight: false },
      { text: 'Kubernetes', highlight: true },
      { text: ' et les détails de la note. '.repeat(10), highlight: false },
    ],
  }
}

for (const width of [1440, 375]) {
  test('pastilles et liste sans séparateurs à ' + width, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.route('**/api/v1/search?**', route => route.fulfill({
      json: { results: [1, 2, 3].map(visualResult), total: 3, page: 1, has_more: false },
    }))
    await page.goto('/search?q=kube')
    const rows = page.locator('.search-result')
    await expect(rows).toHaveCount(3)
    for (const row of await rows.all()) {
      await expect(row).toHaveCSS('border-bottom-width', '0px')
      await expect(row).toHaveCSS('padding-bottom', '0px')
      await expect(row.getByRole('button', { name: 'Voir plus' })).toBeVisible()
      for (const pill of await row.locator('.tags li').all()) {
        expect(await pill.evaluate(element => {
          const li = element.getBoundingClientRect()
          const link = element.querySelector('a')!.getBoundingClientRect()
          return Math.abs(li.width - link.width) < 1 && Math.abs(li.height - link.height) < 1
        })).toBe(true)
      }
    }
    if (width === 375) {
      expect(await rows.first().locator('.tags a').evaluateAll(links =>
        new Set(links.map(link => Math.round(link.getBoundingClientRect().top))).size)).toBeGreaterThan(1)
    }
    for (const theme of ['light', 'dark']) {
      await selectTheme(page, theme)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await expect(rows.first().locator('.search-explanation')).toContainText('Autre source')
      await page.screenshot({ path: info.outputPath('tags-' + theme + '-compact.png'), fullPage: true })
      const toggle = rows.first().locator('.search-excerpt-toggle')
      await toggle.click()
      await expect(toggle).toHaveText('Réduire')
      expect(await rows.first().locator('.search-excerpt:not([aria-hidden])').innerText()).toContain('et les détails de la note.')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: info.outputPath('tags-' + theme + '-expanded.png'), fullPage: true })
      await toggle.click()
      await expect(toggle).toHaveText('Voir plus')
    }
  })
}
