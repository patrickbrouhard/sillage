import { expect, test } from './fixtures'
import { selectTheme } from './navigationHelpers'
import type { SearchResult } from '../src/searchApi'

/** Résultat contrôlé pour les scénarios de réseau et de présentation, sans simulation du moteur. */
function result(title: string): SearchResult {
  return {
    video: { id: 1, created_at: '2026-01-01T00:00:00Z', person_ids: [], tags: [{ id: 1, name: 'SQLite' }],
      sources: [
        { id: 1, provider: 'youtube', title, external_id: null, canonical_url: null, thumbnail_url: null, duration_ms: 125000, description: null, publisher: { id: 1, name: 'Atelier' } },
        { id: 2, provider: 'local', title: 'Autre source technique', external_id: null, canonical_url: null, thumbnail_url: null, duration_ms: null, description: 'Description', publisher: { id: 2, name: 'Publisher secondaire' } },
      ] },
    note_excerpt: [{ text: '<script>texte</script> ', highlight: false }, { text: 'Café', highlight: true }],
    source_matches: [{ source_id: 2, title: true, description: true, publisher: true }],
  }
}

test('invitation, soumissions clavier et loupe sans recherche pendant la frappe', async ({ page }) => {
  const searches: string[] = []
  page.on('request', request => { if (request.url().includes('/api/v1/search?')) searches.push(request.url()) })
  await page.goto('/search')
  await expect(page.getByRole('heading', { name: 'Que souhaitez-vous retrouver ?' })).toBeVisible()
  const field = page.getByRole('searchbox')
  await field.fill('SQLite')
  await page.waitForTimeout(150)
  expect(searches).toHaveLength(0)
  await field.press('Enter')
  await expect(page).toHaveURL('/search?q=SQLite')
  await expect(page.getByRole('heading', { name: 'Comprendre SQLite et ses transactions' })).toBeVisible()
  await expect(field).toBeFocused()
  await field.fill('aucunresultatunivoque')
  expect(searches).toHaveLength(1)
  await page.getByRole('button', { name: 'Lancer la recherche' }).click()
  await expect(page.getByRole('heading', { name: 'Aucun résultat' })).toBeVisible()
  expect(searches).toHaveLength(2)
})

test('API réelle : note, tag et explication publisher', async ({ page, request }) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trsearch001' } })).json()
  await request.put('/api/v1/videos/' + video.id + '/note', { data: { content_md: '# Café Kubernetes', expected_revision: 0 } })
  await request.post('/api/v1/videos/' + video.id + '/tags', { data: { names: ['searchunivoque'] } })
  await page.goto('/search?q=searchunivoque+cafe+kube+ateliers')
  await expect(page.locator('.search-result')).toHaveCount(1)
  await expect(page.locator('.search-excerpt:not([aria-hidden]) mark').first()).toBeVisible()
  await page.getByRole('button', { name: 'Pourquoi cette vidéo apparaît' }).click()
  await expect(page.getByRole('region', { name: 'Explications de la recherche' })).toContainText('publisher')
  await page.keyboard.press('Escape')
  await page.getByRole('heading', { name: 'trsearch001' }).getByRole('link').click()
  await expect(page).toHaveURL('/videos/' + video.id)
  await expect(page.getByRole('searchbox')).toHaveCount(0)
})

test('pagination, rechargement, historique et nouvelle requête sur le même chemin', async ({ page }) => {
  await page.route('**/api/v1/search?**', route => {
    const params = new URL(route.request().url()).searchParams
    const number = Number(params.get('page') || 1)
    return route.fulfill({ json: { results: [result((params.get('q') || '') + ' page ' + number)], page: number, total: 21, has_more: number === 1 } })
  })
  await page.goto('/search?q=initial')
  await expect(page.getByRole('heading', { name: 'initial page 1' })).toBeVisible()
  await page.getByRole('link', { name: 'Page suivante' }).click()
  await expect(page).toHaveURL('/search?q=initial&page=2')
  await expect(page.getByRole('heading', { name: 'initial page 2' })).toBeVisible()
  await expect(page.getByRole('searchbox')).not.toBeFocused()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'initial page 2' })).toBeVisible()
  await page.getByRole('searchbox').fill('nouvelle')
  await page.getByRole('searchbox').press('Enter')
  await expect(page).toHaveURL('/search?q=nouvelle')
  await expect(page.getByRole('heading', { name: 'nouvelle page 1' })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'initial page 2' })).toBeVisible()
  await expect(page.getByRole('searchbox')).toHaveValue('initial')
  await page.goForward()
  await expect(page.getByRole('heading', { name: 'nouvelle page 1' })).toBeVisible()
})

test('ignore une ancienne réponse et permet de réessayer une erreur', async ({ page }) => {
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/v1/search?**', async route => {
    const query = new URL(route.request().url()).searchParams.get('q')
    if (query === 'ancienne') await gate
    if (query === 'erreur') return route.fulfill({ status: 500, json: { error: { code: 'internal_error' } } })
    await route.fulfill({ json: { results: [result(query!)], page: 1, total: 1, has_more: false } }).catch(() => {})
  })
  await page.goto('/search?q=ancienne')
  await expect(page.getByRole('status')).toHaveText('Recherche en cours…')
  await page.getByRole('searchbox').fill('récente')
  await page.getByRole('searchbox').press('Enter')
  await expect(page.getByRole('heading', { name: 'récente', exact: true })).toBeVisible()
  release()
  await expect(page.getByRole('heading', { name: 'ancienne', exact: true })).toHaveCount(0)
  await page.getByRole('searchbox').fill('erreur')
  await page.getByRole('searchbox').press('Enter')
  await expect(page.getByRole('alert')).toContainText('Réessayez')
  await page.unroute('**/api/v1/search?**')
  await page.getByRole('button', { name: 'Réessayer' }).click()
  await expect(page.getByRole('heading', { name: 'Aucun résultat' })).toBeVisible()
})

test('navigation Rechercher refusée puis acceptée et activation sur /search', async ({ page, request }) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trsearch002' } })).json()
  await page.goto('/videos/' + video.id)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await editor.fill('Note non confirmée')
  await page.route('**/note', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 500, json: { error: { code: 'internal_error' } } }) : route.continue())
  const open = () => page.getByRole('button', { name: 'Ouvrir la navigation' }).click()
  const search = () => page.getByRole('navigation').getByRole('link', { name: 'Rechercher', exact: true }).click()
  await open(); await search()
  await expect(page.getByRole('dialog', { name: 'Navigation', exact: true })).toBeHidden()
  const guard = page.getByRole('dialog', { name: 'Quitter la note ?' })
  await expect(guard).toBeVisible()
  await guard.getByRole('button', { name: 'Rester sur la note' }).click()
  await expect(editor).toHaveText('Note non confirmée')
  await expect(page.getByRole('searchbox')).toHaveCount(0)
  await open(); await search()
  await guard.getByRole('button', { name: 'Quitter malgré le risque' }).click()
  await expect(page).toHaveURL('/search')
  await expect(page.getByRole('searchbox')).toBeFocused()
  await page.getByRole('searchbox').fill('non soumise')
  await open(); await search()
  await expect(page.getByRole('searchbox')).toBeFocused()
  await expect(page.locator('dialog[open]')).toHaveCount(0)
})

for (const width of [1440, 768, 375, 320]) {
  test('résultats sûrs et sans débordement à ' + width, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await page.route('**/api/v1/search?**', route => route.fulfill({
      json: { results: [result('Titre technique ' + 'trèslong'.repeat(32))], page: 1, total: 21, has_more: true },
    }))
    await page.goto('/search?q=cafe')
    await expect(page.locator('.search-result')).toBeVisible()
    await expect(page.locator('.search-excerpt:not([aria-hidden])')).toHaveText('<script>texte</script> Café')
    await expect(page.locator('.search-excerpt script')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Pourquoi cette vidéo apparaît' })).toBeVisible()
    await expect(page.locator('.search-explanation')).toBeHidden()
    for (const theme of ['light', 'dark']) {
      await selectTheme(page, theme)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: info.outputPath('search-' + theme + '.png'), fullPage: true })
    }
    if (width === 1440) {
      const center = await page.locator('.global-search-form').evaluate(el => {
        const rect = el.getBoundingClientRect()
        return { center: rect.x + rect.width / 2, band: el.parentElement!.clientWidth / 2 }
      })
      expect(Math.abs(center.center - center.band)).toBeLessThan(18)
      await page.evaluate(() => { document.body.style.zoom = '2' })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: info.outputPath('search-zoom.png'), fullPage: true })
    }
  })
}

test('bandeau desktop de même hauteur sur bibliothèque, recherche et fiche', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trsearch003' } })).json()
  const heights: number[] = []
  for (const path of ['/', '/search', '/videos/' + video.id]) {
    await page.goto(path)
    heights.push(await page.locator('.site-header').evaluate(el => el.getBoundingClientRect().height))
    await expect(page.locator('.site-header')).toHaveCSS('border-bottom-width', '0px')
    await expect(page.locator('.site-header')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  }
  expect(heights).toEqual([56, 56, 56])
})


test('soumettre une recherche identique actualise les données avec Entrée et la loupe', async ({ page, request }) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trsearch004' } })).json()
  const noteURL = '/api/v1/videos/' + video.id + '/note'
  expect((await request.put(noteURL, { data: { content_md: 'actualisationunique Ancien', expected_revision: 0 } })).ok()).toBe(true)
  await page.goto('/search?q=actualisationunique')
  await expect(page.locator('.search-excerpt:not([aria-hidden])')).toContainText('Ancien')
  // Une mutation par un autre client ne change pas l’URL de la recherche ouverte.
  expect((await request.put(noteURL, { data: { content_md: 'actualisationunique Nouveau', expected_revision: 1 } })).ok()).toBe(true)
  await page.getByRole('searchbox').press('Enter')
  await expect(page.locator('.search-excerpt:not([aria-hidden])')).toContainText('Nouveau')
  expect((await request.put(noteURL, { data: { content_md: '', expected_revision: 2 } })).ok()).toBe(true)
  await page.getByRole('button', { name: 'Lancer la recherche' }).click()
  await expect(page.getByRole('heading', { name: 'Aucun résultat' })).toBeVisible()
  await expect(page).toHaveURL('/search?q=actualisationunique')
})

test('la loupe réessaie une recherche identique après une erreur', async ({ page }) => {
  let requests = 0
  await page.route('**/api/v1/search?**', route => {
    requests++
    return requests === 1
      ? route.fulfill({ status: 500, json: { error: { code: 'internal_error' } } })
      : route.fulfill({ json: { results: [result('Résultat retrouvé')], page: 1, total: 1, has_more: false } })
  })
  await page.goto('/search?q=identique')
  await expect(page.getByRole('alert')).toBeVisible()
  await page.getByRole('button', { name: 'Lancer la recherche' }).click()
  await expect(page.getByRole('heading', { name: 'Résultat retrouvé' })).toBeVisible()
  expect(requests).toBe(2)
})
