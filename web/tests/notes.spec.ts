import { test, expect } from './fixtures'

for (const [name, original] of [
  ['LF', '# titre\n\ntexte  \n'],
  ['CRLF', '# titre\r\n\r\ntexte  \r\n'],
  ['CR', '# titre\r\rtexte  \r'],
  ['mixte', '# titre\r\n\ntexte  \nfin\r\n'],
]) {
  test(`note ${name} : édition, Undo/Redo et sauvegarde conservent le Markdown en LF`, async ({ page, request }) => {
    const canonical = original.replace(/\r\n?/g, '\n')
    const added = await request.post('/api/v1/videos', { data: { url: `https://youtu.be/sillage-notes-${name}-${test.info().retry}` } })
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
    await expect.poll(async () => (await (await request.get(url)).json()).content_md).toBe(canonical + 'suite')
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+s')
    await expect.poll(async () => (await (await request.get(url)).json()).content_md).toBe(canonical)
    await page.keyboard.press('Control+Shift+z')
    await page.keyboard.press('Control+s')
    await expect.poll(async () => (await (await request.get(url)).json()).content_md).toBe(canonical + 'suite')
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

test('collage Windows et mixte : LF, caret en fin de ligne, Undo/Redo et persistance', async ({ page, request }) => {
  const { id } = await (await request.post('/api/v1/videos', { data: { url: 'https://youtu.be/sillage-notes-paste-lf' } })).json()
  const url = `/api/v1/videos/${id}/note`
  await page.goto(`/videos/${id}`)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await editor.click()
  const copied = '```go\r\n\tFROM tags\r\n\treturn readTags(rows)\r}\n```  '
  const canonical = '```go\n\tFROM tags\n\treturn readTags(rows)\n}\n```  '
  // Reproduit le texte reçu de Windows par l'événement de collage, sans dépendre du presse-papiers hôte.
  await editor.evaluate((element, text) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  }, copied)
  await expect(editor.locator('.cm-line')).toHaveText(canonical.split('\n'))
  for (const line of ['FROM tags', 'return readTags(rows)']) {
    await editor.locator('.cm-line').filter({ hasText: line }).click()
    await page.keyboard.press('End')
    const caret = await editor.evaluate(() => {
      const selection = window.getSelection()!
      return { text: selection.focusNode?.textContent, height: selection.getRangeAt(0).getBoundingClientRect().height }
    })
    expect(caret.text).not.toContain('\r')
    expect(caret.height).toBeGreaterThan(0)
    await page.keyboard.press('ArrowRight')
    expect(await editor.evaluate(() => window.getSelection()!.focusNode?.textContent)).not.toBe(caret.text)
  }
  await page.keyboard.press('Control+z')
  await expect(editor).toHaveText('')
  await page.keyboard.press('Control+Shift+Z')
  await expect(editor.locator('.cm-line')).toHaveText(canonical.split('\n'))
  await expect.poll(async () => {
    const response = await request.get(url)
    return response.ok() ? (await response.json()).content_md : null
  }).toBe(canonical)
  await expect(page.getByLabel('État de la note')).toHaveText('Enregistré')
})

test('note historique : lecture et départ sans écriture, sauvegarde explicite LF et réponse perdue réconciliée', async ({ page }) => {
  let stored = { video_id: 1, content_md: 'Avant\r\nMilieu\rFin\n', revision: 7, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z' }
  let writes = 0
  await page.route('**/api/v1/videos/1/note', async route => {
    if (route.request().method() === 'PUT') {
      writes++
      const body = route.request().postDataJSON()
      expect(body).toEqual({ content_md: 'Avant\nMilieu\nFin\n', expected_revision: 7 })
      stored = { ...stored, content_md: body.content_md, revision: 8 }
      await route.abort('failed')
    } else await route.fulfill({ json: stored })
  })
  await page.clock.install()
  await page.goto('/videos/1')
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  await expect(editor.locator('.cm-line')).toHaveText(['Avant', 'Milieu', 'Fin', ''])
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await page.clock.runFor(25_000)
  await page.getByRole('link', { name: 'Sillage, accueil' }).click()
  await expect(page).toHaveURL('/')
  expect(writes).toBe(0)
  expect(stored.content_md).toBe('Avant\r\nMilieu\rFin\n')
  await page.goBack()
  await page.getByRole('button', { name: 'Édition', exact: true }).click()
  await expect(editor).toBeVisible()
  await page.getByRole('button', { name: 'Enregistrer la note', exact: true }).click()
  await expect.poll(() => writes).toBe(1)
  await page.clock.runFor(5_000)
  await expect(page.getByLabel('État de la note')).toHaveText('Enregistré')
  await page.clock.runFor(25_000)
  expect(writes).toBe(1)
  expect(stored.revision).toBe(8)
})

test('une lecture échouée ne présente jamais un éditeur vide', async ({ page }) => {
  await page.route('**/api/v1/videos/1/note', route => route.fulfill({ status: 500, json: { error: { code: 'internal_error' } } }))
  await page.goto('/videos/1')
  await expect(page.getByText('Impossible de charger la note.')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toHaveCount(0)
})

test('autosauvegarde après inactivité, aucune écriture à ouverture et document vide conservé', async ({ page, request }) => {
  const response = await request.post('/api/v1/videos', { data: { url: `https://youtu.be/sillage-notes-idle-${test.info().retry}` } })
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
  const { id } = await (await request.post('/api/v1/videos', { data: { url: `https://youtu.be/sillage-notes-continuous-${test.info().retry}` } })).json()
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
  const { id } = await (await request.post('/api/v1/videos', { data: { url: `https://youtu.be/sillage-notes-reading-${test.info().retry}` } })).json()
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
  await expect(page.locator('.markdown-reading a[href^="javascript:"]')).toHaveCount(0)
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
  expect((await (await request.get(url)).json()).content_md).toBe(content.replace(/\r\n?/g, '\n'))
  await page.keyboard.press('Control+Shift+z')
  await page.keyboard.press('Control+s')
  await expect.poll(async () => (await (await request.get(url)).json()).content_md).toBe(content.replace(/\r\n?/g, '\n') + 'suite')
})

test('une réponse perdue est relue sans doubler une écriture et sans perdre la saisie suivante', async ({ page, request }) => {
  const { id } = await (await request.post('/api/v1/videos', { data: { url: `https://youtu.be/sillage-notes-lost-${test.info().retry}` } })).json()
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
  const { id } = await (await request.post('/api/v1/videos', { data: { url: `https://youtu.be/sillage-notes-slow-${test.info().retry}` } })).json()
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

test('deux clients : conflit, nouvelle concurrence et choix conditionnel du local', async ({ page, context, request }) => {
  const { id } = await (await request.post('/api/v1/videos', { data: { url: `https://youtu.be/sillage-notes-conflict-${test.info().retry}` } })).json()
  const url = `/api/v1/videos/${id}/note`
  const second = await context.newPage()
  await page.goto(`/videos/${id}`)
  await second.goto(`/videos/${id}`)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  const other = second.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  await expect(other).toBeVisible()
  await editor.fill('premier onglet')
  await editor.press('Control+s')
  await expect(page.getByLabel('État de la note')).toHaveText('Enregistré')
  await other.fill('second onglet')
  await other.press('Control+s')
  const conflict = second.getByRole('region', { name: 'Résolution du conflit' })
  await expect(conflict).toContainText('premier onglet')
  await expect(other).toHaveText('second onglet')
  // La version présentée au choix devient obsolète avant le clic.
  await request.put(url, { data: { content_md: 'troisième version', expected_revision: 1 } })
  await conflict.getByRole('button', { name: 'Conserver ma version locale' }).click()
  await expect(conflict).toContainText('troisième version')
  expect((await (await request.get(url)).json()).content_md).toBe('troisième version')
  await conflict.getByRole('button', { name: 'Conserver ma version locale' }).click()
  await expect(second.getByLabel('État de la note')).toHaveText('Enregistré')
  expect((await (await request.get(url)).json()).content_md).toBe('second onglet')
  await editor.fill('brouillon à abandonner')
  await editor.press('Control+s')
  await expect(page.getByRole('region', { name: 'Résolution du conflit' })).toContainText('second onglet')
  await page.getByRole('button', { name: 'Conserver la version serveur', exact: true }).click()
  await expect(editor).toHaveText('second onglet')
  expect((await (await request.get(url)).json()).revision).toBe(3)
  await second.close()
})

test('résultat incertain : ne reprend jamais une révision concurrente pour écraser', async ({ page, request }) => {
  const { id } = await (await request.post('/api/v1/videos', { data: { url: `https://youtu.be/sillage-notes-uncertain-conflict-${test.info().retry}` } })).json()
  const url = `/api/v1/videos/${id}/note`
  let writes = 0
  await page.route('**' + url, async route => {
    if (route.request().method() !== 'PUT') { await route.continue(); return }
    writes++
    const saved = await (await route.fetch()).json()
    await request.put(url, { data: { content_md: 'version concurrente', expected_revision: saved.revision } })
    await route.abort('failed')
  })
  await page.goto(`/videos/${id}`)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await editor.fill('local')
  await editor.press('Control+s')
  await expect(page.getByRole('region', { name: 'Résolution du conflit' })).toContainText('version concurrente')
  await editor.press('End')
  await editor.press('!')
  await page.waitForTimeout(2_200)
  expect(writes).toBe(1)
  expect((await (await request.get(url)).json()).content_md).toBe('version concurrente')
})

test('réessais réseau bornés, reprise manuelle et saisie conservée', async ({ page, request }) => {
  const { id } = await (await request.post('/api/v1/videos', { data: { url: `https://youtu.be/sillage-notes-retry-${test.info().retry}` } })).json()
  const url = `/api/v1/videos/${id}/note`
  await page.goto(`/videos/${id}`)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  let calls = 0
  await page.route('**' + url, async route => { calls++; await route.abort('failed') })
  await editor.fill('conservé malgré la panne')
  await editor.press('Control+s')
  await expect(page.getByLabel('État de la note')).toContainText('après deux réessais', { timeout: 8_000 })
  expect(calls).toBe(3)
  await editor.press('End')
  await editor.press('!')
  await page.waitForTimeout(2_200)
  expect(calls).toBe(3)
  await page.unroute('**' + url)
  await page.getByRole('button', { name: 'Réessayer la sauvegarde' }).click()
  await expect(page.getByLabel('État de la note')).toHaveText('Enregistré')
  expect((await (await request.get(url)).json()).content_md).toBe('conservé malgré la panne!')
})

test('navigation interne attend la sauvegarde puis précédent retrouve le contenu', async ({ page, request }) => {
  const { id } = await (await request.post('/api/v1/videos', { data: { url: `https://youtu.be/sillage-notes-navigation-${test.info().retry}` } })).json()
  const url = `/api/v1/videos/${id}/note`
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**' + url, async route => {
    if (route.request().method() === 'PUT') await gate
    await route.continue()
  })
  await page.goto('/')
  await page.goto(`/videos/${id}`)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await editor.fill('avant départ')
  await page.getByRole('link', { name: 'Sillage, accueil' }).click()
  await expect(page.getByRole('dialog', { name: 'Quitter la note ?' })).toBeVisible()
  await expect(page).toHaveURL(`/videos/${id}`)
  release()
  await expect(page).toHaveURL('/')
  expect((await (await request.get(url)).json()).content_md).toBe('avant départ')
  await page.goBack()
  await expect(editor).toHaveText('avant départ')
})

test('précédent bloqué après erreur : rester, puis quitter explicitement', async ({ page, request }) => {
  const { id } = await (await request.post('/api/v1/videos', { data: { url: `https://youtu.be/sillage-notes-back-${test.info().retry}` } })).json()
  const url = `/api/v1/videos/${id}/note`
  await page.goto('/')
  await page.getByRole('link', { name: `Consulter : sillage-notes-back-${test.info().retry}`, exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  await page.route('**' + url, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 413, json: { error: { code: 'payload_too_large' } } }) : route.continue())
  await editor.fill('reste local')
  await page.goBack()
  const dialog = page.getByRole('dialog', { name: 'Quitter la note ?' })
  await expect(dialog).toContainText('ne sont pas confirmées')
  await dialog.getByRole('button', { name: 'Rester sur la note' }).click()
  await expect(editor).toHaveText('reste local')
  await page.goBack()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Quitter malgré le risque' }).click()
  await expect(page).toHaveURL('/')
  expect((await request.get(url)).status()).toBe(404)
  await page.goForward()
  await expect(editor).toHaveText('')
})

test('rechargement avertit si non confirmé ; un refus garde le document', async ({ page, request }) => {
  const { id } = await (await request.post('/api/v1/videos', { data: { url: `https://youtu.be/sillage-notes-unload-${test.info().retry}` } })).json()
  await page.goto(`/videos/${id}`)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await editor.fill('à conserver')
  const dialog = page.waitForEvent('dialog')
  const reload = page.reload({ timeout: 2_000 }).catch(() => null)
  const warning = await dialog
  expect(warning.type()).toBe('beforeunload')
  await warning.dismiss()
  await expect(editor).toHaveText('à conserver')
  await reload
})

test('note vide explicite et sélection conservée entre Édition et Lecture', async ({ page, request }) => {
  const { id } = await (await request.post('/api/v1/videos', { data: { url: `https://youtu.be/sillage-notes-selection-${test.info().retry}` } })).json()
  const url = `/api/v1/videos/${id}/note`
  await page.goto(`/videos/${id}`)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  await page.getByRole('button', { name: 'Enregistrer la note', exact: true }).click()
  await expect(page.getByLabel('État de la note')).toHaveText('Enregistré')
  expect((await (await request.get(url)).json()).content_md).toBe('')
  await editor.fill('abcDEF')
  await editor.press('Control+End')
  for (let i = 0; i < 3; i++) await editor.press('Shift+ArrowLeft')
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await page.getByRole('button', { name: 'Édition', exact: true }).click()
  await expect(editor).toBeFocused()
  await page.keyboard.type('Z')
  await page.keyboard.press('Control+s')
  await expect.poll(async () => (await (await request.get(url)).json()).content_md).toBe('abcZ')
})

test('un lien Markdown interne traverse la sauvegarde avant navigation', async ({ page, request }) => {
  const { id } = await (await request.post('/api/v1/videos', { data: { url: `https://youtu.be/sillage-notes-markdown-link-${test.info().retry}` } })).json()
  const url = `/api/v1/videos/${id}/note`
  await page.goto(`/videos/${id}`)
  await page.getByRole('textbox', { name: 'Note Markdown' }).fill('[Retour Markdown](/)')
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await page.getByRole('link', { name: 'Retour Markdown' }).click()
  await expect(page).toHaveURL('/')
  expect((await (await request.get(url)).json()).content_md).toBe('[Retour Markdown](/)')
})
