import { test, expect } from '@playwright/test'

for (const [name, original] of [
  ['LF', '# titre\n\ntexte  \n'],
  ['CRLF', '# titre\r\n\r\ntexte  \r\n'],
  ['mixte', '# titre\r\n\ntexte  \nfin\r\n'],
]) {
  test(`note ${name} : édition, Undo/Redo et sauvegarde préservent le texte exact`, async ({ page, request }) => {
    const added = await request.post('/api/v1/videos', { data: { url: `https://youtu.be/sillage-notes-${name}` } })
    const video = await added.json()
    const url = `/api/v1/videos/${video.id}/note`
    await request.put(url, { data: { content_md: original, expected_revision: 0 } })
    await page.goto(`/videos/${video.id}`)
    const editor = page.getByRole('textbox', { name: 'Note Markdown' })
    await expect(editor).toBeVisible()
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('suite')
    await page.keyboard.press('Control+s')
    await expect.poll(async () => (await (await request.get(url)).json()).content_md).toBe(original + 'suite')
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+s')
    await expect.poll(async () => (await (await request.get(url)).json()).content_md).toBe(original)
    await page.keyboard.press('Control+Shift+z')
    await page.keyboard.press('Control+s')
    await expect.poll(async () => (await (await request.get(url)).json()).content_md).toBe(original + 'suite')
    // Un autre client gagne ; le brouillon local reste visible et n'écrase rien.
    const current = await (await request.get(url)).json()
    await request.put(url, { data: { content_md: 'serveur', expected_revision: current.revision } })
    await page.keyboard.type(' locale')
    await page.keyboard.press('Control+s')
    await expect(page.getByRole('status').filter({ hasText: 'Conflit' })).toBeVisible()
    expect((await (await request.get(url)).json()).content_md).toBe('serveur')
    await expect(editor).toContainText('suite locale')
  })
}

test('une lecture échouée ne présente jamais un éditeur vide', async ({ page }) => {
  await page.route('**/api/v1/videos/1/note', route => route.fulfill({ status: 500, json: { error: { code: 'internal_error' } } }))
  await page.goto('/videos/1')
  await expect(page.getByText('Impossible de charger la note.')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toHaveCount(0)
})

test('autosauvegarde après inactivité, aucune écriture à ouverture et document vide conservé', async ({ page, request }) => {
  const response = await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/sillage-notes-idle' } })
  const { id } = await response.json()
  const url = `/api/v1/videos/${id}/note`
  let writes = 0
  page.on('request', req => { if (req.method() === 'PUT' && req.url().endsWith(url)) writes++ })
  await page.clock.install()
  await page.goto(`/videos/${id}`)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  await page.clock.runFor(25_000)
  expect(writes).toBe(0)
  expect((await request.get(url)).status()).toBe(404)
  await editor.fill('Une note')
  await page.clock.runFor(1_900)
  expect(writes).toBe(0)
  await page.clock.runFor(200)
  await expect.poll(() => writes).toBe(1)
  await expect(page.getByLabel('État de la note')).toHaveText('Enregistré')
  await page.clock.runFor(25_000)
  expect(writes).toBe(1)
  await editor.fill('')
  await page.keyboard.press('Control+s')
  await expect.poll(async () => (await (await request.get(url)).json()).content_md).toBe('')
  expect((await (await request.get(url)).json()).revision).toBe(2)
})

test('saisie continue enregistrée à 20 secondes puis nouveau cycle', async ({ page, request }) => {
  const { id } = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/sillage-notes-continuous' } })).json()
  const url = `/api/v1/videos/${id}/note`
  let writes = 0
  page.on('request', req => { if (req.method() === 'PUT' && req.url().endsWith(url)) writes++ })
  await page.clock.install()
  await page.goto(`/videos/${id}`)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  for (let i = 0; i < 20; i++) {
    await editor.press('x')
    await page.clock.runFor(1_000)
  }
  await expect.poll(() => writes).toBe(1)
  await expect(page.getByLabel('État de la note')).toHaveText('Enregistré')
  await editor.press('y')
  await page.clock.runFor(2_100)
  await expect.poll(() => writes).toBe(2)
})

test('lecture GFM sûre, texte mixte et historique conservés à la bascule', async ({ page, request }) => {
  const { id } = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/sillage-notes-reading' } })).json()
  const url = `/api/v1/videos/${id}/note`
  const content = '| A | B |\r\n| - | - |\n| un | deux |\r\n\n- [x] Fait\n\n<script>window.compromised = true</script>\n\n[lien](javascript:alert(1))\n'
  await request.put(url, { data: { content_md: content, expected_revision: 0 } })
  let writes = 0
  page.on('request', req => { if (req.method() === 'PUT' && req.url().endsWith(url)) writes++ })
  await page.goto(`/videos/${id}`)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await expect(page.getByRole('table')).toBeVisible()
  await expect(page.getByRole('checkbox', { checked: true })).toBeDisabled()
  await expect(page.locator('.markdown-reading script')).toHaveCount(0)
  expect(await page.getByRole('link', { name: 'lien', exact: true }).getAttribute('href')).not.toContain('javascript:')
  expect(writes).toBe(0)
  await page.getByRole('button', { name: 'Édition', exact: true }).click()
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('suite')
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await expect(page.getByLabel('Lecture de la note')).toContainText('suite')
  await page.getByRole('button', { name: 'Édition', exact: true }).click()
  await editor.focus()
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+s')
  expect((await (await request.get(url)).json()).content_md).toBe(content)
  await page.keyboard.press('Control+Shift+z')
  await page.keyboard.press('Control+s')
  await expect.poll(async () => (await (await request.get(url)).json()).content_md).toBe(content + 'suite')
})

test('une réponse perdue est relue sans doubler une écriture et sans perdre la saisie suivante', async ({ page, request }) => {
  const { id } = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/sillage-notes-lost' } })).json()
  const url = `/api/v1/videos/${id}/note`
  let writes = 0
  await page.route('**' + url, async route => {
    if (route.request().method() !== 'PUT') { await route.continue(); return }
    writes++
    if (writes === 1) {
      await route.fetch()
      await route.abort('failed')
    } else await route.continue()
  })
  await page.goto(`/videos/${id}`)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await editor.fill('premier')
  await page.keyboard.press('Control+s')
  await editor.press('End')
  await editor.press('!')
  await expect.poll(async () => (await (await request.get(url)).json()).content_md).toBe('premier!')
  await expect(page.getByLabel('État de la note')).toHaveText('Enregistré')
  expect(writes).toBe(2)
  expect((await (await request.get(url)).json()).revision).toBe(2)
})

test('une écriture lente conserve les frappes et sérialise Ctrl+S', async ({ page, request }) => {
  const { id } = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/sillage-notes-slow' } })).json()
  const url = `/api/v1/videos/${id}/note`
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let writes = 0
  await page.route('**' + url, async route => {
    if (route.request().method() !== 'PUT') { await route.continue(); return }
    writes++
    if (writes === 1) await gate
    await route.continue()
  })
  await page.goto(`/videos/${id}`)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await editor.fill('a')
  await page.keyboard.press('Control+s')
  await expect.poll(() => writes).toBe(1)
  await editor.press('End')
  await editor.press('b')
  await page.keyboard.press('Control+s')
  expect(writes).toBe(1)
  release()
  await expect.poll(async () => (await (await request.get(url)).json()).content_md).toBe('ab')
  await expect(page.getByLabel('État de la note')).toHaveText('Enregistré')
  expect(writes).toBe(2)
})
