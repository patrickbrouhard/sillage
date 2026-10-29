import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { openEditor, selection } from './editorTestHelpers'

// Les limites de connexion sont globales au serveur ; ces scénarios ne les saturent pas entre eux.
test.describe.configure({ mode: 'serial' })

/** Chaque scénario de sécurité possède sa propre session et ne révoque pas la fixture partagée. */
async function connect(page: Page) {
  await page.context().clearCookies()
  await page.goto('/')
  await page.getByLabel('Identifiant', { exact: true }).fill('test-owner')
  await page.getByLabel('Mot de passe', { exact: true }).fill('sillage test password phrase')
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
}

async function revoke(page: Page) {
  const state = await (await page.request.get('/api/v1/auth/session')).json()
  const response = await page.request.post('/api/v1/auth/logout', { headers: { 'X-CSRF-Token': state.csrf_token } })
  expect(response.status()).toBe(204)
}

async function reconnect(page: Page) {
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByLabel('Identifiant', { exact: true }).fill('test-owner')
  await page.getByLabel('Mot de passe', { exact: true }).fill('sillage test password phrase')
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
}

test('refuse les données anonymes, connecte et révoque la session réelle', async ({ page }) => {
  await page.context().clearCookies()
  expect((await page.request.get('/api/v1/videos')).status()).toBe(401)
  expect((await page.request.get('/mcp')).status()).toBe(404)
  await page.goto('/videos/1')
  await expect(page.getByRole('heading', { name: 'Connexion à Sillage' })).toBeVisible()
  await page.getByLabel('Identifiant', { exact: true }).fill('test-owner')
  await page.getByLabel('Mot de passe', { exact: true }).fill('incorrect')
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Identifiant ou mot de passe incorrect.')
  await reconnect(page)
  const cookies = await page.context().cookies()
  const cookie = cookies.find(cookie => cookie.name === 'sillage_session')!
  expect(cookie.httpOnly).toBe(true)
  expect(cookie.sameSite).toBe('Lax')
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toBeVisible()
  await page.getByRole('button', { name: 'Ouvrir la navigation' }).click()
  await page.getByText('Session', { exact: true }).click()
  await page.getByRole('button', { name: 'Se déconnecter', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Connexion à Sillage' })).toBeVisible()
  expect((await page.request.get('/api/v1/videos')).status()).toBe(401)
})

test('une reconnexion préserve la vue, la sélection, Undo et le brouillon', async ({ page }) => {
  await connect(page)
  const { editor, writes } = await openEditor(page, 'Texte initial')
  await editor.press('ControlOrMeta+End')
  await editor.pressSequentially(' ajouté')
  await page.evaluate(() => window.editorProbe.select(2, 7))
  const before = await selection(editor)
  const element = await page.locator('.cm-editor').elementHandle()
  // Un refus simulé pilote le verrouillage ; la révocation utilise la vraie session du serveur.
  let rejected = false
  await page.route('**/api/v1/videos/42/note', async route => {
    if (!rejected && route.request().method() === 'PUT') {
      rejected = true
      await route.fulfill({ status: 401, json: { error: { code: 'authentication_required' } } })
    } else await route.fallback()
  })
  await revoke(page)
  await page.getByRole('button', { name: 'Enregistrer la note', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(await element!.evaluate(node => node.isConnected)).toBe(true)
  expect(await page.evaluate(() => window.editorProbe.snapshot())).toMatchObject(before)
  await reconnect(page)
  expect(await element!.evaluate(node => node.isConnected)).toBe(true)
  expect(await selection(editor)).toMatchObject(before)
  await expect.poll(() => writes.at(-1)).toBe('Texte initial ajouté')
  await editor.focus()
  await editor.press('ControlOrMeta+z')
  await expect.poll(() => page.evaluate(() => window.editorProbe.snapshot().doc)).toBe('Texte initial')
})

test('réconcilie une écriture perdue après reconnexion sans second PUT', async ({ page }) => {
  await connect(page)
  const { editor } = await openEditor(page, 'Initial')
  let stored = { video_id: 42, content_md: 'Initial', revision: 1, updated_at: '2026-10-28' }
  let writes = 0
  let locked = false
  await page.route('**/api/v1/videos/42/note', async route => {
    if (route.request().method() === 'PUT') {
      writes++
      stored = { ...stored, content_md: route.request().postDataJSON().content_md, revision: 2 }
      await revoke(page)
      locked = true
      await route.abort('failed')
    } else if (locked) {
      await route.fulfill({ status: 401, json: { error: { code: 'authentication_required' } } })
    } else await route.fulfill({ json: stored })
  })
  await editor.fill('Sauvegarde déjà effectuée')
  await page.getByRole('button', { name: 'Enregistrer la note', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  locked = false
  await reconnect(page)
  await expect(page.getByRole('button', { name: 'Enregistrer la note', exact: true })).toHaveAttribute('data-save-state', 'success')
  expect(writes).toBe(1)
  await expect(editor).toContainText('Sauvegarde déjà effectuée')
})

test('garde le conflit et refuse une nouvelle révision sans décision explicite', async ({ page }) => {
  await connect(page)
  const { editor } = await openEditor(page, 'Initial')
  let writes = 0
  await page.route('**/api/v1/videos/42/note', async route => {
    if (route.request().method() === 'PUT') {
      writes++
      await route.fulfill({ status: 409, json: { error: { code: 'note_conflict' } } })
    } else await route.fulfill({ json: { video_id: 42, content_md: 'Version distante', revision: 3, updated_at: '2026-10-28' } })
  })
  await editor.fill('Brouillon en conflit')
  await page.getByRole('button', { name: 'Enregistrer la note', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Résolution du conflit' })).toBeVisible()
  await revoke(page)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await reconnect(page)
  await expect(page.getByRole('region', { name: 'Résolution du conflit' })).toBeVisible()
  await expect(editor).toContainText('Brouillon en conflit')
  expect(writes).toBe(1)
})

test('la déconnexion dans un autre onglet verrouille sans perdre son brouillon', async ({ page }) => {
  await connect(page)
  const peer = await page.context().newPage()
  try {
    const { editor } = await openEditor(peer, 'Note du second onglet')
    await editor.press('ControlOrMeta+End')
    await editor.pressSequentially(' modifiée')
    const before = await selection(editor)
    await page.getByRole('button', { name: 'Ouvrir la navigation' }).click()
    await page.getByText('Session', { exact: true }).click()
    await page.getByRole('button', { name: 'Se déconnecter', exact: true }).click()
    await expect(peer.getByRole('dialog')).toBeVisible()
    expect(await peer.evaluate(() => window.editorProbe.snapshot())).toMatchObject(before)
    await reconnect(peer)
    expect(await selection(editor)).toMatchObject(before)
    await expect(page.getByRole('dialog')).not.toBeVisible()
  } finally { await peer.close() }
})

test('l’autosauvegarde réelle reprend après révocation avec la même précondition', async ({ page }) => {
  await connect(page)
  const session = await (await page.request.get('/api/v1/auth/session')).json()
  const response = await page.request.post('/api/v1/videos', {
    headers: { 'X-CSRF-Token': session.csrf_token },
    data: { url: 'https://youtu.be/sillage-notes-auth-session' },
  })
  expect(response.ok()).toBe(true)
  const video = await response.json()
  await page.goto('/videos/' + video.id)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  await revoke(page)
  await editor.fill('Brouillon conservé après refus réel du serveur')
  await expect(page.getByRole('dialog')).toBeVisible()
  await reconnect(page)
  await expect.poll(async () => {
    const response = await page.request.get('/api/v1/videos/' + video.id + '/note')
    return response.ok() ? (await response.json()).content_md : ''
  }).toBe('Brouillon conservé après refus réel du serveur')
  await expect(editor).toContainText('Brouillon conservé après refus réel du serveur')
})

test('une lecture initiale suspendue ne remplace pas le brouillon après reconnexion', async ({ page }) => {
  await connect(page)
  let release: () => void = () => {}
  const pending = new Promise<void>(resolve => { release = resolve })
  let reads = 0
  let finished = false
  await page.route('**/api/v1/videos/1/note', async route => {
    if (route.request().method() !== 'GET') return route.fulfill({ json: {
      video_id: 1, content_md: route.request().postDataJSON().content_md,
      revision: 2, updated_at: '2026-10-28',
    } })
    const first = ++reads === 1
    if (first) await pending
    await route.fulfill({ json: {
      video_id: 1, content_md: first ? 'Ancienne lecture' : 'Note relue',
      revision: 1, updated_at: '2026-10-28',
    } })
    if (first) finished = true
  })
  try {
    await page.goto('/videos/1')
    await expect.poll(() => reads).toBe(1)
    await revoke(page)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    const aborted = page.waitForEvent('requestfailed', {
      predicate: request => request.url().endsWith('/videos/1/note'),
    })
    await reconnect(page)
    await aborted
    const editor = page.getByRole('textbox', { name: 'Note Markdown' })
    await expect(editor).toContainText('Note relue')
    await editor.fill('Brouillon après reconnexion')
    release()
    await expect.poll(() => finished).toBe(true)
    await expect(editor).toContainText('Brouillon après reconnexion')
  } finally { release() }
})

// Le fournisseur est simulé ici ; les signatures et le protocole sont exercés dans les tests Go.
test('la reconnexion SSO secondaire conserve CodeMirror, la sélection, Undo et Redo', async ({ page }) => {
  await connect(page)
  const { editor, writes } = await openEditor(page, 'Texte initial')
  await editor.press('ControlOrMeta+End')
  await page.keyboard.insertText(' ajouté')
  await page.evaluate(() => window.editorProbe.select(2, 7))
  const before = await selection(editor)
  const element = await page.locator('.cm-editor').elementHandle()
  await page.route('**/api/v1/auth/session', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...await response.json(), methods: 'oidc' } })
  })
  await page.route('**/api/v1/auth/oidc/start', route => route.fulfill({ json: { url: 'https://provider.test/authorize' } }))
  const origin = new URL(page.url()).origin
  await page.context().route('https://provider.test/authorize', async route => {
    const state = await (await page.request.get('/api/v1/auth/session')).json()
    const login = await page.request.post('/api/v1/auth/login', {
      headers: { 'X-CSRF-Token': state.csrf_token },
      data: { username: 'test-owner', password: 'sillage test password phrase' },
    })
    expect(login.status()).toBe(200)
    await route.fulfill({ status: 302, headers: { Location: origin + '/?oidc=complete' } })
  })
  await revoke(page)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByLabel('Mot de passe', { exact: true })).toHaveCount(0)
  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Se connecter avec le SSO' }).click()
  const popup = await popupPromise
  await expect.poll(() => popup.isClosed()).toBe(true)
  await expect(page.getByRole('dialog')).not.toBeVisible()
  expect(await element!.evaluate(node => node.isConnected)).toBe(true)
  expect(await selection(editor)).toMatchObject(before)
  await expect.poll(() => writes.at(-1)).toBe('Texte initial ajouté')
  await editor.focus()
  await editor.press('ControlOrMeta+z')
  await expect.poll(() => page.evaluate(() => window.editorProbe.snapshot().doc)).toBe('Texte initial')
  await editor.press('ControlOrMeta+Shift+z')
  await expect.poll(() => page.evaluate(() => window.editorProbe.snapshot().doc)).toBe('Texte initial ajouté')
})

test('une fenêtre SSO bloquée propose un autre onglet sans naviguer dans le brouillon', async ({ page }) => {
  await connect(page)
  const { editor } = await openEditor(page, 'Brouillon conservé')
  await editor.press('ControlOrMeta+End')
  await page.keyboard.insertText(' ici')
  const element = await page.locator('.cm-editor').elementHandle()
  const originalURL = page.url()
  await page.route('**/api/v1/auth/session', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...await response.json(), methods: 'oidc' } })
  })
  await page.route('**/api/v1/auth/oidc/start', route => route.fulfill({ json: { url: 'https://provider.test/authorize' } }))
  await page.evaluate(() => { window.open = () => null })
  await revoke(page)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByRole('button', { name: 'Se connecter avec le SSO' }).click()
  const fallback = page.getByRole('link', { name: 'Ouvrir la connexion dans un autre onglet' })
  await expect(fallback).toHaveAttribute('target', '_blank')
  expect(page.url()).toBe(originalURL)
  expect(await element!.evaluate(node => node.isConnected)).toBe(true)
  expect(await page.evaluate(() => window.editorProbe.snapshot().doc)).toBe('Brouillon conservé ici')
})

test('une déconnexion volontaire ne relance pas le SSO', async ({ page }) => {
  await connect(page)
  let starts = 0
  await page.route('**/api/v1/auth/session', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...await response.json(), methods: 'both' } })
  })
  await page.route('**/api/v1/auth/oidc/start', route => {
    starts++
    return route.fulfill({ status: 503 })
  })
  await page.getByRole('button', { name: 'Ouvrir la navigation' }).click()
  await page.getByText('Session', { exact: true }).click()
  await page.getByRole('button', { name: 'Se déconnecter', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Connexion à Sillage' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Se connecter avec le SSO' })).toBeVisible()
  expect(starts).toBe(0)
})
