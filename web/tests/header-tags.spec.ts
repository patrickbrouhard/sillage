import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import type { Tag } from '../src/api'

/** Isole le classement déjà chargé, sans catalogue ni mutation implicite. */
async function openVideo(page: Page, tags: Tag[], width = 1920, title = 'Un titre confortable qui conserve sa place à côté des tags '.repeat(4)) {
  let reads = 0
  await page.route('**/api/v1/videos/42', route => {
    reads++
    return route.fulfill({ json: {
      id: 42, created_at: '2026-10-21', person_ids: [], tags,
      sources: [{ id: 1, provider: 'youtube', external_id: 'abcdefghijk',
        title }],
    } })
  })
  await page.route('**/note', route => route.fulfill({ status: 404, json: { error: { code: 'note_not_found' } } }))
  await page.setViewportSize({ width, height: 1080 })
  await page.goto('/videos/42')
  await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toBeVisible()
  return () => reads
}

test('préfixe mesuré, compteur exact et aucune relecture à ouverture ou redimensionnement', async ({ page }, info) => {
  const tags = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: 'Classement numéro ' + i }))
  const reads = await openVideo(page, tags, 1920, 'Un titre confortable qui conserve sa place à côté des tags')
  const visible = page.locator('.detail-tags a')
  await expect(visible).not.toHaveCount(0)
  const desktopCount = await visible.count()
  expect(desktopCount).toBeLessThan(tags.length)
  const more = page.getByRole('button', { name: /Afficher les .* autres tags/ })
  await expect(more).toHaveText('+' + (tags.length - desktopCount))
  await expect(visible).toHaveText(tags.slice(0, desktopCount).map(tag => tag.name))
  const counterBox = await more.boundingBox()
  const managerBox = await page.getByRole('button', { name: 'Gérer les tags', exact: true }).boundingBox()
  expect(managerBox!.x - counterBox!.x - counterBox!.width).toBeCloseTo(6, 0)
  await page.screenshot({ path: info.outputPath('header-tags-desktop.png') })
  await expect(page.locator('.workspace-note .video-tags')).toHaveCount(0)
  await expect(page.locator('.site-header .video-tags')).toBeVisible()
  await more.focus()
  await more.press('Enter')
  const popup = page.getByRole('region', { name: 'Autres tags de la vidéo' })
  await expect(popup).toBeVisible()
  await more.press('Tab')
  await expect(popup.getByRole('link').first()).toBeFocused()
  await expect(popup.getByRole('link')).toHaveText(tags.slice(desktopCount).map(tag => tag.name))
  await page.screenshot({ path: info.outputPath('header-tags-popover.png') })
  await page.keyboard.press('Escape')
  await expect(popup).toBeHidden()
  await expect(more).toBeFocused()
  await page.setViewportSize({ width: 1100, height: 1080 })
  await expect.poll(() => visible.count()).toBeLessThan(desktopCount)
  await page.setViewportSize({ width: 3840, height: 2160 })
  await expect(visible).toHaveCount(tags.length)
  await expect(more).toBeHidden()
  // Le lien focalisé qui quitte la ligne doit retrouver un accès visible, sans perdre le focus.
  await visible.last().focus()
  await page.setViewportSize({ width: 320, height: 812 })
  await expect(more).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(reads()).toBe(1)
  await page.screenshot({ path: info.outputPath('header-tags-mobile.png'), fullPage: true })
})

test('aucun tag ne tient : noms complets dans le popover, gestion séparée et aucune page agrandie', async ({ page }) => {
  const longName = 'Un nom très long '.repeat(40)
  const tags = [{ id: 1, name: longName }, { id: 2, name: 'Court' }]
  await openVideo(page, tags, 375)
  const more = page.getByRole('button', { name: 'Afficher les 2 autres tags' })
  await expect(more).toHaveText('+2')
  await expect(page.locator('.detail-tags a')).toHaveCount(0)
  const height = await page.evaluate(() => document.documentElement.scrollHeight)
  await more.click()
  const popup = page.getByRole('region', { name: 'Autres tags de la vidéo' })
  await expect(popup.getByRole('link').first()).toHaveText(longName)
  const box = await popup.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(375)
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(height)
  await page.getByRole('button', { name: 'Gérer les tags', exact: true }).click()
  await expect(popup).toBeHidden()
  await expect(page.getByRole('dialog', { name: 'Gérer les tags' })).toBeVisible()
  await page.getByRole('button', { name: 'Fermer', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Gérer les tags', exact: true })).toBeFocused()
})

test('popover fermé avant une navigation de tag protégée par la note', async ({ page }) => {
  await openVideo(page, [{ id: 5, name: 'Tag long '.repeat(70) }])
  await page.getByRole('textbox', { name: 'Note Markdown' }).fill('Brouillon')
  await page.route('**/note', route => route.fulfill({ status: 400, json: { error: { code: 'bad_request' } } }))
  await page.getByRole('button', { name: 'Afficher le dernier tag' }).click()
  const popup = page.getByRole('region', { name: 'Autres tags de la vidéo' })
  await popup.getByRole('link').click()
  await expect(popup).toBeHidden()
  await expect(page.getByRole('dialog', { name: 'Quitter la note ?' })).toBeVisible()
  await page.getByRole('button', { name: 'Rester sur la note' }).click()
  await expect(page).toHaveURL('/videos/42')
  await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toHaveText('Brouillon')
})

test('sans tags : gestion accessible, titre mobile borné et espace libéré dans Note', async ({ page }) => {
  await openVideo(page, [], 320)
  await expect(page.getByRole('button', { name: 'Ajouter des tags' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Afficher les .* autres tags/ })).toBeHidden()
  const title = await page.locator('.header-video-title h1').boundingBox()
  expect(title!.height).toBeLessThanOrEqual(54)
  const tags = await page.locator('.video-tags').boundingBox()
  expect(tags!.y).toBeGreaterThanOrEqual(title!.y + title!.height)
  const note = await page.locator('.workspace-note').boundingBox()
  const tabs = await page.getByRole('tablist').boundingBox()
  expect(tabs!.y - note!.y).toBeLessThan(4)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('compteurs à trois chiffres, redimensionnement du popover et ouverture du volet', async ({ page }) => {
  const tags = Array.from({ length: 105 }, (_, i) => ({ id: i + 1, name: 'Tag détaillé numéro ' + i }))
  await openVideo(page, tags, 320)
  const more = page.getByRole('button', { name: /Afficher les .* autres tags/ })
  await expect(more).toHaveText(/^\+10[0-5]$/)
  const visibleCount = await page.locator('.detail-tags a').count()
  await expect(more).toHaveText('+' + (tags.length - visibleCount))
  await more.click()
  const popup = page.getByRole('region', { name: 'Autres tags de la vidéo' })
  await popup.getByRole('link').first().focus()
  await page.setViewportSize({ width: 1920, height: 1080 })
  await expect(popup).toBeHidden()
  await expect(more).toBeFocused()
  await more.click()
  await page.getByRole('button', { name: 'Ouvrir la navigation' }).click()
  await expect(popup).toBeHidden()
  await expect(page.getByRole('dialog', { name: 'Navigation', exact: true })).toBeVisible()
})

test('ajout et retrait recalculent les tags sans remontage de la note', async ({ page, request }) => {
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/trHdrTags01' } })).json()
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/videos/' + video.id)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  const node = await editor.elementHandle()
  await page.getByRole('button', { name: 'Ajouter des tags', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Gérer les tags' })
  await expect(dialog.getByRole('status')).toHaveText('Associations actualisées.')
  await dialog.getByRole('combobox').fill('Tag très long pour le classement de cette vidéo particulière')
  await dialog.getByRole('combobox').press('Enter')
  await expect(dialog.getByRole('status')).toHaveText('Associations enregistrées.')
  await dialog.getByRole('button', { name: 'Fermer', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Afficher le dernier tag' })).toBeVisible()
  await page.getByRole('button', { name: 'Gérer les tags', exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText('Associations actualisées.')
  await dialog.getByRole('button', { name: /Retirer le tag/ }).click()
  await expect(dialog.getByRole('status')).toHaveText('Tag retiré de cette vidéo.')
  await dialog.getByRole('button', { name: 'Fermer', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Ajouter des tags', exact: true })).toBeVisible()
  await expect(page.locator('.tag-overflow-button').first()).toBeHidden()
  expect(await node!.evaluate(el => el === document.querySelector('.cm-content'))).toBe(true)
})


test('centrage réel et repli déterministe pendant un redimensionnement progressif', async ({ page }, info) => {
  const tags = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, name: 'Classement détaillé numéro ' + i }))
  await openVideo(page, tags, 1920, 'Une vidéo consacrée aux connaissances et à leur organisation')
  const editor = await page.getByRole('textbox', { name: 'Note Markdown' }).elementHandle()
  const modes = new Set<string>()
  const samples = new Map<number, string>()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  for (const width of [...Array.from({ length: 42 }, (_, i) => 1920 - i * 20), 1100,
    ...Array.from({ length: 42 }, (_, i) => 1100 + i * 20)]) {
    await page.setViewportSize({ width, height: 1080 })
    // Observer plusieurs frames à taille constante : le mode ne doit pas s'auto-invalider.
    const frames = await page.evaluate(async () => {
      const result: string[] = []
      for (let frame = 0; frame < 5; frame++) {
        await new Promise(requestAnimationFrame)
        const host = document.querySelector<HTMLElement>('.video-header-content')!
        const rect = host.getBoundingClientRect()
        result.push(JSON.stringify({ mode: host.dataset.centered, x: rect.x, width: rect.width,
          count: document.querySelectorAll('.detail-tags a').length }))
      }
      return result
    })
    expect(new Set(frames.slice(1)).size).toBe(1)
    const sample = frames.at(-1)!
    if (samples.has(width)) expect(sample).toBe(samples.get(width))
    samples.set(width, sample)
    const geometry = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>('.video-header-content')!
      const h = host.getBoundingClientRect()
      const nav = document.querySelector('.header-navigation')!.getBoundingClientRect()
      const header = document.querySelector('.site-header')!.getBoundingClientRect()
      return { mode: host.dataset.centered!, center: h.x + h.width / 2,
        expectedCenter: header.x + header.width / 2, left: h.left, right: h.right,
        navigationRight: nav.right, pageWidth: header.right, overflow: document.documentElement.scrollWidth > innerWidth }
    })
    if (geometry.mode === 'true' && !modes.has('true')) {
      await page.screenshot({ path: info.outputPath('centered-desktop.png') })
    }
    modes.add(geometry.mode)
    if (geometry.mode === 'true') expect(geometry.center).toBeCloseTo(geometry.expectedCenter, 0)
    else expect(geometry.left - geometry.navigationRight).toBeCloseTo(16, 0)
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.navigationRight + 15)
    expect(geometry.right).toBeLessThanOrEqual(geometry.pageWidth - 15)
    expect(geometry.overflow).toBe(false)
  }
  expect([...modes].sort()).toEqual(['false', 'true'])
  const ordered = [...samples.keys()].sort((a, b) => a - b)
  const boundary = ordered.find((width, index) => index > 0
    && JSON.parse(samples.get(width)!).mode !== JSON.parse(samples.get(ordered[index - 1])!).mode)!
  expect(boundary).toBeDefined()
  const fineSamples = new Map<number, string>()
  const fineWidths = Array.from({ length: 41 }, (_, i) => boundary - 20 + i)
  for (const width of [...fineWidths, ...[...fineWidths].reverse()]) {
    await page.setViewportSize({ width, height: 1080 })
    const frames = await page.evaluate(async () => {
      const values: string[] = []
      for (let frame = 0; frame < 4; frame++) {
        await new Promise(requestAnimationFrame)
        const host = document.querySelector<HTMLElement>('.video-header-content')!
        values.push(JSON.stringify({ mode: host.dataset.centered, x: host.getBoundingClientRect().x,
          count: document.querySelectorAll('.detail-tags a').length }))
      }
      return values
    })
    expect(new Set(frames.slice(1)).size).toBe(1)
    const value = frames.at(-1)!
    if (fineSamples.has(width)) expect(value).toBe(fineSamples.get(width))
    fineSamples.set(width, value)
  }
  expect(errors).toEqual([])
  expect(await editor!.evaluate(el => el === document.querySelector('.cm-content'))).toBe(true)
  for (const width of [1920, 1440, 1100, 375]) {
    await page.setViewportSize({ width, height: 1080 })
    await page.screenshot({ path: info.outputPath('center-' + width + '.png') })
  }
})

test('titre prioritaire sans plafond artificiel, compteur accessible et espace vertical compact', async ({ page }) => {
  const title = 'Connaissances et organisation '.repeat(15)
  await openVideo(page, [{ id: 1, name: 'Un classement' }], 1920, title)
  await expect(page.locator('.detail-tags a')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Afficher le dernier tag' })).toBeVisible()
  const h1 = page.locator('#video-title')
  await expect(h1).toHaveText(title)
  expect((await h1.boundingBox())!.width).toBeGreaterThan(1400)
  await expect(page.locator('.video-header-content')).toHaveAttribute('data-centered', 'false')
  expect((await page.locator('.site-header').boundingBox())!.height).toBe(56)
  expect((await page.locator('.video-workspace').boundingBox())!.height).toBe(1000)
  await page.setViewportSize({ width: 1920, height: 600 })
  expect((await page.locator('.video-workspace').boundingBox())!.height).toBeGreaterThanOrEqual(608)
  expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(true)
})


test('un tag plus court que son compteur reste visible même avec un titre très long', async ({ page }) => {
  await openVideo(page, [{ id: 1, name: 'a' }], 1440, 'Un titre très long '.repeat(30))
  await expect(page.locator('.detail-tags a')).toHaveText(['a'])
  await expect(page.getByRole('button', { name: 'Afficher le dernier tag' })).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
