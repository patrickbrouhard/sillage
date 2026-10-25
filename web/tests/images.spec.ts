import type { APIRequestContext, Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { test, expect } from './fixtures'
import type { Asset } from '../src/assetApi'

// Un PNG plein format texturé exerce les transferts et le décodage, pas seulement le CSS.
const png = execFileSync('/usr/bin/ffmpeg', [
  '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080,noise=alls=12:allf=t',
  '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
], { maxBuffer: 16 * 1024 * 1024 })

/** Contrôle le catalogue seulement ; la note et ses révisions traversent le serveur réel. */
async function setup(page: Page, request: APIRequestContext, content = 'alpha omega') {
  const externalID = 'trlp' + test.info().testId.slice(-7)
  const video = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/' + externalID } })).json()
  const noteURL = `/api/v1/videos/${video.id}/note`
  await request.put(noteURL, { data: { content_md: content, expected_revision: 0 } })
  const assets: Asset[] = Array.from({ length: 14 }, (_, i) => ({
    id: 800 + i, video_id: video.id, source_id: video.sources[0].id, timestamp_ms: i * 1000,
    type: 'screenshot', status: 'available', error_code: '', created_at: '2026-10-25T12:00:00Z',
  }))
  let lists = 0, writes = 0, creations = 0, individual = 0, contents = 0
  page.on('request', r => {
    if (r.method() === 'PUT' && r.url().endsWith('/note')) writes++
    if (r.method() === 'POST' && r.url().endsWith('/captures')) creations++
    if (/\/assets\/\d+$/.test(r.url())) individual++
  })
  await page.route(`**/api/v1/videos/${video.id}/assets?*`, async route => {
    lists++
    const current = Number(new URL(route.request().url()).searchParams.get('page'))
    await route.fulfill({ json: { assets: assets.slice((current - 1) * 12, current * 12), page: current, has_more: current * 12 < assets.length } })
  })
  await page.route('**/api/v1/assets/*/content', async route => {
    contents++
    await route.fulfill({ contentType: 'image/png', body: png })
  })
  await page.goto('/videos/' + video.id)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  const images = page.getByRole('button', { name: 'Images', exact: true })
  const panel = page.getByRole('dialog', { name: 'Images', exact: true })
  return { video, assets, noteURL, editor, images, panel, counts: () => ({ lists, writes, creations, individual, contents }) }
}

test('catalogue borné plein format, consultation sans écriture, pause YouTube et focus non modal', async ({ page, request }) => {
  const c = await setup(page, request)
  const bounds = await c.editor.boundingBox()
  await page.evaluate(() => { const p = window.youtubeTest.players.at(-1)!; p.position = 42; p.emitState(1) })
  await c.images.click()
  await expect(c.panel).toBeVisible()
  await expect(c.panel).not.toHaveAttribute('aria-modal', 'true')
  await expect(page.locator('.image-card')).toHaveCount(12)
  expect(await c.editor.boundingBox()).toEqual(bounds)
  expect(await page.locator('.video-player').getAttribute('inert')).not.toBeNull()
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.state)).toBe(2)
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.destroyed)).toBe(false)
  await c.editor.click()
  await expect(c.panel).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(c.panel).toHaveCount(0)
  await expect(c.editor).toBeFocused()
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.state)).toBe(2)
  expect(c.counts().writes).toBe(0)
  expect(c.counts().creations).toBe(0)
  expect(c.counts().individual).toBe(0)
  expect(c.counts().contents).toBeLessThanOrEqual(12)
  expect(png.length).toBeGreaterThan(1000000)
  await test.info().attach('images-transfer.json', {
    contentType: 'application/json',
    body: JSON.stringify({ png_bytes: png.length, loaded_images: c.counts().contents, maximum_page_images: 12 }),
  })
})

test('pages et agrandissement conservent la grille, Échap ferme une seule surface', async ({ page, request }) => {
  const c = await setup(page, request)
  await c.images.click()
  await expect(page.locator('.image-card')).toHaveCount(12)
  await page.locator('.images-scroll').evaluate(el => { el.scrollTop = 150 })
  const thumbnail = page.getByRole('button', { name: 'Agrandir la capture à 0:03, YouTube', exact: true })
  await thumbnail.click()
  const scroll = await page.locator('.images-scroll').evaluate(el => el.scrollTop)
  await expect(page.getByRole('dialog', { name: 'Agrandissement de l’image' })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('image-viewer.png') })
  await page.keyboard.press('Escape')
  await expect(c.panel).toBeVisible()
  await expect(thumbnail).toBeFocused()
  expect(await page.locator('.images-scroll').evaluate(el => el.scrollTop)).toBe(scroll)
  await c.panel.getByRole('button', { name: 'Suivant', exact: true }).click()
  await expect(page.locator('.image-card')).toHaveCount(2)
  await expect(c.panel.getByText('Page 2', { exact: true })).toBeVisible()
  await expect(c.panel.getByRole('heading', { name: 'Images', exact: true })).toBeFocused()
  await expect(c.panel.getByRole('button', { name: 'Suivant', exact: true })).toBeDisabled()
  await page.screenshot({ path: test.info().outputPath('images-desktop.png') })
  await page.keyboard.press('Escape')
  await expect(c.images).toBeFocused()
  expect(c.counts().writes).toBe(0)
})

test('pending, failed et PNG indisponible restent distincts et réessayables', async ({ page, request }) => {
  const c = await setup(page, request)
  c.assets.splice(3)
  c.assets[0].status = 'pending'
  c.assets[1].status = 'failed'
  await page.route('**/api/v1/assets/802/content', route => route.fulfill({ status: 409 }))
  await c.images.click()
  await expect(c.panel.getByText('Capture en cours de génération…')).toBeVisible()
  await expect(c.panel.getByText('La génération de cette capture a échoué ou a été interrompue.')).toBeVisible()
  await expect(c.panel.getByText('Image indisponible.', { exact: false })).toBeVisible()
  await page.unroute('**/api/v1/assets/802/content')
  await c.panel.getByRole('button', { name: 'Réessayer l’affichage' }).click()
  await expect(c.panel.locator('img')).toHaveCount(1)
  c.assets[0].status = 'available'
  await expect(c.panel.locator('img')).toHaveCount(2)
  const count = c.counts().lists
  await page.waitForTimeout(2200)
  expect(c.counts().lists).toBe(count)
  expect(c.counts().individual).toBe(0)
  expect(c.counts().creations).toBe(0)
})

test('échec catalogue puis liste vide, sans création de note ou capture', async ({ page, request }) => {
  const c = await setup(page, request)
  await page.route(`**/api/v1/videos/${c.video.id}/assets?*`, route => route.fulfill({ status: 500 }))
  await c.images.click()
  await expect(c.panel.getByRole('alert')).toContainText('Impossible de consulter les images')
  await page.unroute(`**/api/v1/videos/${c.video.id}/assets?*`)
  c.assets.splice(0)
  await page.route(`**/api/v1/videos/${c.video.id}/assets?*`, route => route.fulfill({ json: { assets: [], page: 1, has_more: false } }))
  await c.panel.getByRole('button', { name: 'Réessayer le catalogue' }).click()
  await expect(c.panel.getByRole('status')).toHaveText('Aucune capture pour cette vidéo.')
  expect(c.counts().writes).toBe(0)
})

test('responsive conserve éditeur et catalogue et applique une modalité réelle', async ({ page, request }) => {
  const c = await setup(page, request)
  await c.editor.click()
  await page.keyboard.press('Control+End')
  await c.images.click()
  await expect(page.locator('.image-card')).toHaveCount(12)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(c.panel).toHaveAttribute('aria-modal', 'true')
  expect(await c.panel.evaluate(el => el.matches(':modal'))).toBe(true)
  expect(await c.panel.boundingBox()).toMatchObject({ x: 0, y: 0, height: 844 })
  await page.screenshot({ path: test.info().outputPath('images-mobile.png') })
  await page.keyboard.press('Escape')
  await expect(c.images).toBeFocused()
  await c.editor.focus()
  await page.keyboard.type(' suite')
  await expect(c.editor).toHaveText('alpha omega suite')
})

test('pause non confirmée refuse Images sans destruction ni perte du choix masqué', async ({ page, request }) => {
  const c = await setup(page, request)
  await page.evaluate(() => { window.youtubeTest.confirmPause = false; window.youtubeTest.players.at(-1)!.emitState(1) })
  await c.images.click()
  await expect(page.getByRole('alert')).toContainText('pause YouTube n’a pas été confirmée')
  await expect(c.panel).toHaveCount(0)
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.destroyed)).toBe(false)
  await page.evaluate(() => { window.youtubeTest.confirmPause = true })
  await page.getByRole('button', { name: 'Masquer la vidéo', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Afficher la vidéo', exact: true })).toBeVisible()
  await c.images.click()
  await c.panel.getByRole('button', { name: 'Fermer Images' }).click()
  await expect(page.getByRole('button', { name: 'Afficher la vidéo', exact: true })).toBeVisible()
})

test('Local poursuit une vraie lecture HTML5 sous Images sans changement de surface', async ({ page, request }) => {
  const c = await setup(page, request)
  const url = `/api/v1/videos/${c.video.id}/sources/${c.video.sources[0].id}/download`
  await expect.poll(async () => (await request.post(url)).status(), { timeout: 15000 }).not.toBe(503)
  await expect.poll(async () => (await (await request.get(url)).json()).status).toBe('available')
  await page.reload()
  const media = page.locator('video')
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2)
  await media.evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play() })
  const time = await media.evaluate((v: HTMLVideoElement) => v.currentTime)
  await c.images.click()
  await expect(c.panel).toBeVisible()
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(time + 0.2)
  expect(await media.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false)
  await c.panel.getByRole('button', { name: 'Fermer Images' }).click()
  expect(await media.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false)
})

test('réinsertion exige un choix explicite, suit une sélection inversée et conserve le focus galerie', async ({ page, request }) => {
  const c = await setup(page, request)
  await c.images.click()
  const insert = c.panel.getByRole('button', { name: 'Insérer la capture à 0:00, YouTube', exact: true })
  await insert.click()
  await expect(c.panel.getByRole('alert')).toContainText('Placez explicitement le curseur')
  expect(c.counts().writes).toBe(0)
  await c.editor.click()
  await page.keyboard.press('Control+Home')
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft')
  await expect(page.locator('.image-insertion-selection')).toHaveText('alpha')
  await insert.click()
  await expect(insert).toBeFocused()
  const md = '![Capture à 0:00](/api/v1/assets/800/content) '
  await expect(c.editor).toHaveText('alpha' + md + ' omega')
  await expect(page.locator('.image-insertion-caret')).toHaveCount(1)
  await expect(page.getByRole('status', { name: 'Insertion d’image' })).toContainText('Image insérée')
  await insert.click()
  await expect(c.editor).toHaveText('alpha' + md + md + ' omega')
  await expect(insert).toBeFocused()
  await c.editor.focus()
  await page.keyboard.press('Control+z')
  await expect(c.editor).toHaveText('alpha' + md + ' omega')
  await page.keyboard.press('Control+z')
  await expect(c.editor).toHaveText('alpha omega')
  await page.keyboard.press('Control+Shift+Z')
  await expect(c.editor).toHaveText('alpha' + md + ' omega')
  await page.keyboard.press('Control+End')
  await insert.click()
  await expect(c.editor).toHaveText('alpha' + md + ' omega' + md)
  await expect.poll(async () => (await (await request.get(c.noteURL)).json()).content_md).toBe('alpha' + md + ' omega' + md)
  expect(c.counts().creations).toBe(0)
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
  await page.screenshot({ path: test.info().outputPath('images-insertion.png') })
})

test('note vide accepte les ajouts successifs mais les blancs exigent un emplacement', async ({ page, request }) => {
  const c = await setup(page, request, '')
  await c.images.click()
  const insert = c.panel.getByRole('button', { name: 'Insérer la capture à 0:00, YouTube', exact: true })
  await insert.click()
  await insert.click()
  const md = '![Capture à 0:00](/api/v1/assets/800/content) '
  await expect(c.editor).toHaveText(md + md)
  await expect(insert).toBeFocused()
  await page.keyboard.press('Escape')
  await c.editor.focus()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('   ')
  await page.keyboard.press('Control+s')
  await expect.poll(async () => (await (await request.get(c.noteURL)).json()).content_md).toBe('   ')
  await page.reload()
  await c.images.click()
  await insert.click()
  await expect(c.panel.getByRole('alert')).toContainText('Placez explicitement le curseur')
  await expect(c.editor).toHaveText('   ')
})

test('Lecture consulte sans insérer ; pending et failed ne permettent aucun ajout', async ({ page, request }) => {
  const c = await setup(page, request)
  c.assets.splice(3)
  c.assets[0].status = 'pending'
  c.assets[1].status = 'failed'
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await c.images.click()
  await expect(c.panel.getByText('Passez en Édition pour insérer une image.')).toBeVisible()
  for (const button of await c.panel.getByRole('button', { name: /^Insérer la capture/ }).all()) await expect(button).toBeDisabled()
  await page.getByRole('button', { name: 'Édition', exact: true }).click()
  await expect(c.panel.getByRole('button', { name: 'Insérer la capture à 0:02, YouTube', exact: true })).toBeEnabled()
  await expect(c.panel.getByRole('button', { name: 'Insérer la capture à 0:00, YouTube', exact: true })).toBeDisabled()
  await expect(c.panel.getByRole('button', { name: 'Insérer la capture à 0:01, YouTube', exact: true })).toBeDisabled()
  expect(c.counts().writes).toBe(0)
})

test('mobile ferme après insertion au point choisi et préserve Undo, sans seek', async ({ page, request }) => {
  const c = await setup(page, request)
  await page.setViewportSize({ width: 390, height: 844 })
  await c.editor.click()
  await page.keyboard.press('Control+End')
  await c.images.click()
  const insert = c.panel.getByRole('button', { name: 'Insérer la capture à 0:00, YouTube', exact: true })
  await expect(insert).toHaveCSS('opacity', '1')
  await insert.click()
  await expect(c.panel).toHaveCount(0)
  await expect(c.editor).toBeFocused()
  await page.keyboard.type('suite')
  await expect(c.editor).toHaveText('alpha omega![Capture à 0:00](/api/v1/assets/800/content) suite')
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  await expect(c.editor).toHaveText('alpha omega')
})

test('conflit autorise l’ajout local, remplacement de session invalide le choix précédent', async ({ page, request }) => {
  const c = await setup(page, request)
  await c.editor.click()
  await page.keyboard.press('Control+End')
  const current = await (await request.get(c.noteURL)).json()
  await request.put(c.noteURL, { data: { content_md: 'serveur', expected_revision: current.revision } })
  await page.keyboard.type(' local')
  await page.keyboard.press('Control+s')
  await expect(page.getByRole('region', { name: 'Résolution du conflit' })).toBeVisible()
  await c.images.click()
  const insert = c.panel.getByRole('button', { name: 'Insérer la capture à 0:00, YouTube', exact: true })
  const writes = c.counts().writes
  await insert.click()
  await expect(c.editor).toContainText('/api/v1/assets/800/content')
  await page.waitForTimeout(2200)
  expect(c.counts().writes).toBe(writes)
  await page.getByRole('button', { name: 'Conserver la version serveur', exact: true }).click()
  await expect(c.editor).toHaveText('serveur')
  await insert.click()
  await expect(c.panel.getByRole('alert')).toContainText('Placez explicitement le curseur')
  await expect(c.editor).toHaveText('serveur')
})

test('navigation admissible ferme Images ; une autre source refuse sans seek ni fermeture', async ({ page, request }) => {
  const c = await setup(page, request)
  await c.editor.click()
  await page.keyboard.press('Control+End')
  const uri = `sillage://videos/${c.video.id}/sources/${c.video.sources[0].id}?start_ms=12000`
  await page.keyboard.type(` [temps](${uri}) [autre](sillage://videos/${c.video.id}/sources/99999?start_ms=1000)`)
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await c.images.click()
  await page.getByRole('button', { name: 'autre', exact: true }).click()
  await expect(c.panel).toBeVisible()
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
  await page.getByRole('button', { name: 'temps', exact: true }).click()
  await expect(c.panel).toHaveCount(0)
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toHaveLength(1)
})

test('une reprise YouTube tardive non confirmée rend le lecteur accessible avec une erreur', async ({ page, request }) => {
  const c = await setup(page, request)
  await c.images.click()
  await expect(c.panel).toBeVisible()
  await page.evaluate(() => { window.youtubeTest.confirmPause = false; window.youtubeTest.players.at(-1)!.emitState(1) })
  await expect(c.panel).toHaveCount(0)
  await expect(page.getByRole('alert')).toContainText('pause YouTube n’a pas été confirmée')
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.destroyed)).toBe(false)
  await expect(page.locator('.video-player')).not.toHaveAttribute('inert')
})

test('insertion révélée dans une longue note sans déplacer le focus de la galerie', async ({ page, request }) => {
  const c = await setup(page, request, 'ligne\n'.repeat(250) + 'fin')
  await c.editor.click()
  await page.keyboard.press('Control+End')
  await c.images.click()
  await page.locator('.note-content').evaluate(el => { el.scrollTop = 0 })
  const insert = c.panel.getByRole('button', { name: 'Insérer la capture à 0:00, YouTube', exact: true })
  await insert.click()
  await expect(insert).toBeFocused()
  await expect.poll(() => page.locator('.note-content').evaluate(el => el.scrollTop)).toBeGreaterThan(1000)
  const caret = await page.locator('.image-insertion-caret').boundingBox()
  const bounds = await page.locator('.note-content').boundingBox()
  expect(caret!.y).toBeGreaterThanOrEqual(bounds!.y)
  expect(caret!.y + caret!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height)
})

test('la protection de départ reste la surface active, puis la vidéo suivante réinitialise Images', async ({ page, request }) => {
  const c = await setup(page, request)
  await page.route(`**${c.noteURL}`, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503 }) : route.continue())
  await c.editor.click()
  await page.keyboard.type('local ')
  await c.images.click()
  await page.getByRole('link', { name: 'Sillage, accueil', exact: true }).first().click()
  const leave = page.getByRole('dialog', { name: 'Quitter la note ?' })
  await expect(leave).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(leave).not.toBeVisible()
  await expect(c.panel).toBeVisible()
  await expect(c.editor).toContainText('local ')
  await page.getByRole('link', { name: 'Sillage, accueil', exact: true }).first().click()
  await leave.getByRole('button', { name: 'Quitter malgré le risque' }).click()
  await expect(page).toHaveURL('/')
  await page.goto('/videos/' + c.video.id)
  await expect(c.images).toHaveAttribute('aria-expanded', 'false')
  await expect(c.editor).toHaveText('alpha omega')
})

test.describe('écran tactile de largeur desktop', () => {
  test.use({ hasTouch: true, viewport: { width: 1440, height: 900 } })
  test('le plus reste visible sans survol', async ({ page, request }) => {
    const c = await setup(page, request)
    await c.images.click()
    await expect(c.panel.getByRole('button', { name: 'Insérer la capture à 0:00, YouTube', exact: true })).toHaveCSS('opacity', '1')
  })
})

test('un autofocus Édition ne choisit pas une position et Informations conserve le focus galerie après ajout', async ({ page, request }) => {
  const c = await setup(page, request)
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await page.getByRole('button', { name: 'Édition', exact: true }).click()
  await c.images.click()
  const insert = c.panel.getByRole('button', { name: 'Insérer la capture à 0:00, YouTube', exact: true })
  await insert.click()
  await expect(c.panel.getByRole('alert')).toContainText('Placez explicitement le curseur')
  await c.editor.click()
  await page.keyboard.press('Control+End')
  await page.getByRole('tab', { name: 'Informations', exact: true }).click()
  await insert.click()
  await expect(page.getByRole('tab', { name: 'Note', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(insert).toBeFocused()
  await expect(c.editor).toHaveText('alpha omega![Capture à 0:00](/api/v1/assets/800/content) ')
})

test('navigation depuis un lecteur terminé garde son contrat de démarrage après fermeture Images', async ({ page, request }) => {
  const c = await setup(page, request, '')
  await c.editor.click()
  await page.keyboard.type(`[temps](sillage://videos/${c.video.id}/sources/${c.video.sources[0].id}?start_ms=12000)`)
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(0))
  await c.images.click()
  await page.getByRole('button', { name: 'temps', exact: true }).click()
  await expect(c.panel).toHaveCount(0)
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.state)).toBe(1)
})

test('un ancien catalogue annulé ne remplace pas une consultation rouverte', async ({ page, request }) => {
  const c = await setup(page, request)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  await page.route(`**/api/v1/videos/${c.video.id}/assets?*`, async route => {
    const first = ++calls === 1
    if (first) await gate
    await route.fulfill({ json: { assets: [{ ...c.assets[0], status: first ? 'failed' : 'available' }], page: 1, has_more: false } })
  })
  await c.images.click()
  await expect(c.panel.getByText('Chargement des images…')).toBeVisible()
  await c.panel.getByRole('button', { name: 'Fermer Images' }).click()
  await c.images.click()
  await expect(c.panel.locator('img')).toHaveCount(1)
  release()
  await expect(c.panel.getByText('La génération de cette capture a échoué ou a été interrompue.')).toHaveCount(0)
  expect(c.counts().writes).toBe(0)
})

test('les badges identifient les VideoSource sans commande de navigation', async ({ page, request }) => {
  const c = await setup(page, request)
  c.assets.splice(2)
  c.assets[1].source_id = 99999
  await page.route(`**/api/v1/videos/${c.video.id}`, route => route.fulfill({ json: {
    ...c.video, sources: [...c.video.sources, { ...c.video.sources[0], id: 99999, title: 'Autre provenance' }],
  } }))
  await page.reload()
  await c.images.click()
  await expect(page.locator('.image-provenance')).toHaveText([
    `YouTube · source ${c.video.sources[0].id}`, 'YouTube · source 99999',
  ])
  await page.locator('.image-provenance').last().click({ force: true })
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
})
