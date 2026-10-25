import { expect, test } from './fixtures'
import { selectTheme } from './navigationHelpers'
import type { SearchResult } from '../src/searchApi'

/** Conserve les contributions partielles réelles du contrat avec des dates et identités contrôlées. */
function item(id: number, explanations = true): SearchResult {
  return {
    video: {
      id,
      created_at: '2026-10-24T12:00:00.000Z',
      person_ids: [],
      tags: [{ id: 1, name: 'Kubernetes' }],
      sources: [
        { id: id * 10, provider: 'local', title: 'Kubernetes ' + id, publisher: { id: 1, name: 'TechWorld' },
          external_id: null, canonical_url: null, thumbnail_url: null, duration_ms: null, description: 'Description' },
        { id: id * 10 + 1, provider: 'local', title: '<script>Autre source</script>', publisher: { id: 2, name: 'Atelier' },
          external_id: null, canonical_url: null, thumbnail_url: null, duration_ms: null, description: 'Description secondaire' },
      ],
    },
    source_matches: explanations ? [
      { source_id: id * 10, title: true, description: true, publisher: true },
      { source_id: id * 10 + 1, title: false, description: true, publisher: true },
    ] : [{ source_id: id * 10, title: true, description: false, publisher: false }],
    note_excerpt: [{ text: 'Kubernetes', highlight: true }],
  }
}

test('date ajoutée, explications inchangées et aucune icône pour le titre seul', async ({ page }) => {
  let requests = 0
  await page.route('**/api/v1/search?**', route => {
    requests++
    return route.fulfill({ json: { results: [item(1), item(2, false)], page: 1, total: 2, has_more: false } })
  })
  await page.goto('/search?q=kube')
  const rows = page.locator('.search-result')
  const metadata = rows.first().locator('.search-metadata')
  await expect(metadata).toContainText('TechWorld · Ajoutée le 24 oct. 2026')
  await expect(metadata.locator('time')).toHaveAttribute('datetime', '2026-10-24T12:00:00.000Z')
  await expect(rows.nth(1).getByRole('button', { name: 'Pourquoi cette vidéo apparaît' })).toHaveCount(0)
  const trigger = rows.first().getByRole('button', { name: 'Pourquoi cette vidéo apparaît' })
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('region', { name: 'Explications de la recherche' })).toHaveCount(0)
  await trigger.click()
  const panel = page.getByRole('region', { name: 'Explications de la recherche' })
  await expect(panel.locator('.search-explanation')).toHaveText([
    'Correspondance : titre, description, publisher (TechWorld)',
    'Autre source : <script>Autre source</script> — description, publisher (Atelier)',
  ])
  await expect(panel.locator('script')).toHaveCount(0)
  expect(await trigger.getAttribute('aria-controls')).toBe(await panel.getAttribute('id'))
  expect(await trigger.getAttribute('aria-describedby')).toBe(await panel.getAttribute('id'))
  await page.getByRole('status').click()
  await expect(panel).toBeHidden()
  expect(requests).toBe(1)
})

test('délai de survol, passage bref annulé et clic immédiat sans réouverture tardive', async ({ page }) => {
  await page.route('**/api/v1/search?**', route => route.fulfill({
    json: { results: [item(1)], page: 1, total: 1, has_more: false },
  }))
  await page.goto('/search?q=kube')
  const trigger = page.getByRole('button', { name: 'Pourquoi cette vidéo apparaît' })
  const panel = page.getByRole('region', { name: 'Explications de la recherche' })
  await expect(trigger).toBeVisible()
  await page.clock.install({ time: new Date('2026-10-25T12:00:00Z') })
  await page.clock.pauseAt(new Date('2026-10-25T12:00:01Z'))
  await trigger.hover()
  await page.clock.runFor(299)
  await expect(panel).toBeHidden()
  await page.clock.runFor(1)
  await expect(panel).toBeVisible()
  await page.getByRole('status').hover()
  await page.clock.runFor(150)
  await expect(panel).toBeHidden()
  await trigger.hover()
  await page.clock.runFor(100)
  await page.getByRole('status').hover()
  await page.clock.runFor(500)
  await expect(panel).toBeHidden()
  await trigger.hover()
  await trigger.click()
  await expect(panel).toBeVisible()
  await trigger.click()
  await expect(panel).toBeHidden()
  await page.clock.runFor(500)
  await expect(panel).toBeHidden()
  await page.mouse.move(0, 0)
  await trigger.hover()
  await trigger.press('Escape')
  await page.clock.runFor(500)
  await expect(panel).toBeHidden()
})

test('survol traversable, clic persistant, clavier, Échap et focus', async ({ page }) => {
  await page.route('**/api/v1/search?**', route => route.fulfill({
    json: { results: [item(1)], page: 1, total: 1, has_more: false },
  }))
  await page.goto('/search?q=kube')
  const trigger = page.getByRole('button', { name: 'Pourquoi cette vidéo apparaît' })
  const panel = page.getByRole('region', { name: 'Explications de la recherche' })
  await trigger.hover()
  await expect(panel).toBeVisible()
  await panel.hover()
  await expect(panel).toBeVisible()
  await page.getByRole('heading', { name: 'Kubernetes 1' }).hover()
  await expect(panel).toBeHidden()
  await trigger.hover()
  await trigger.click()
  await page.getByRole('heading', { name: 'Kubernetes 1' }).hover()
  // Dépasser le délai de fermeture du survol vérifie que le clic a fixé la consultation.
  await page.waitForTimeout(200)
  await expect(panel).toBeVisible()
  await trigger.click()
  await expect(panel).toBeHidden()
  await page.mouse.move(0, 0)
  await trigger.focus()
  await trigger.press('Enter')
  await expect(panel).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await trigger.press('Tab')
  await expect(panel).toBeFocused()
  await panel.press('Escape')
  await expect(panel).toBeHidden()
  await expect(trigger).toBeFocused()
  await trigger.press('Space')
  await expect(panel).toBeVisible()
  await trigger.press('Escape')
  await expect(panel).toBeHidden()
  await expect(trigger).toBeFocused()
})

test.describe('consultation tactile', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 700 } })

  test('toucher pour ouvrir, fermer et quitter le panneau', async ({ page }) => {
    await page.route('**/api/v1/search?**', route => route.fulfill({
      json: { results: [item(1)], page: 1, total: 1, has_more: false },
    }))
    await page.goto('/search?q=kube')
    const trigger = page.getByRole('button', { name: 'Pourquoi cette vidéo apparaît' })
    const panel = page.getByRole('region', { name: 'Explications de la recherche' })
    await trigger.tap()
    await expect(panel).toBeVisible()
    await trigger.tap()
    await expect(panel).toBeHidden()
    await trigger.tap()
    await expect(panel).toBeVisible()
    await page.getByRole('status').tap()
    await expect(panel).toBeHidden()
    await expect(page.locator('.tags a')).toHaveText('Kubernetes')
    await expect(page.locator('.search-excerpt:not([aria-hidden])')).toHaveText('Kubernetes')
  })
})

for (const width of [1440, 320]) {
  test('panneau borné, long, clair et sombre à ' + width, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 600 })
    const result = item(1)
    for (let id = 12; id < 40; id++) {
      result.video.sources.push({ ...result.video.sources[1], id, title: 'Autre source ' + 'trèslong'.repeat(20) })
      result.source_matches.push({ source_id: id, title: true, description: true, publisher: true })
    }
    await page.route('**/api/v1/search?**', route => route.fulfill({
      json: { results: [result], page: 1, total: 1, has_more: false },
    }))
    await page.goto('/search?q=kube')
    const trigger = page.getByRole('button', { name: 'Pourquoi cette vidéo apparaît' })
    const panel = page.getByRole('region', { name: 'Explications de la recherche' })
    for (const theme of ['light', 'dark']) {
      await selectTheme(page, theme)
      await trigger.click()
      await expect(panel).toBeVisible()
      expect(await panel.evaluate(element => {
        const rect = element.getBoundingClientRect()
        return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
      })).toBe(true)
      await panel.focus()
      await panel.press('PageDown')
      await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: info.outputPath('search-info-' + theme + '.png') })
      await panel.press('Escape')
      await expect(trigger).toBeFocused()
    }
    if (width === 1440) {
      await page.evaluate(() => { document.body.style.zoom = '2' })
      await trigger.click()
      await expect(panel).toBeVisible()
      expect(await panel.evaluate(element => {
        const rect = element.getBoundingClientRect()
        return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
      })).toBe(true)
    }
  })
}
