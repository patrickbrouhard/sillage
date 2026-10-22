import { test, expect } from './fixtures'

for (const automatic of [false, true]) {
  test('confirmation fidèle, expiration et aucun succès sans écriture : automatique ' + automatic, async ({ page }) => {
    let stored = { video_id: 1, content_md: 'Initial', revision: 7, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-21T12:34:56Z' }
    let writes = 0
    await page.route('**/api/v1/videos/1/note', async route => {
      if (route.request().method() === 'PUT') {
        writes++
        stored = { ...stored, content_md: route.request().postDataJSON().content_md, revision: stored.revision + 1 }
      }
      await route.fulfill({ json: stored })
    })
    await page.clock.install()
    await page.goto('/videos/1')
    const save = page.getByRole('button', { name: 'Enregistrer la note', exact: true })
    const editor = page.getByRole('textbox', { name: 'Note Markdown' })
    await expect(save).toHaveAttribute('data-save-state', 'idle')
    await save.click()
    expect(writes).toBe(0)
    await expect(save).toHaveAttribute('data-save-state', 'idle')
    await editor.fill('Modifié')
    await expect(save).toHaveAttribute('data-save-state', 'pending')
    if (automatic) await page.clock.runFor(2_100)
    else await save.click()
    await expect(save).toHaveAttribute('data-save-state', 'success')
    expect(writes).toBe(1)
    const tooltip = page.locator('.note-save [role=tooltip]')
    await expect(tooltip).toContainText('Enregistré. Dernier contenu confirmé : révision 8')
    await expect(tooltip).toContainText('21/10/2026')
    await expect(save).toHaveAttribute('aria-describedby', await tooltip.getAttribute('id') as string)
    await save.focus()
    await save.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(save).toBeFocused()
    await expect(tooltip).toBeVisible()
    await save.press('Escape')
    await expect(tooltip).toBeHidden()
    await page.clock.runFor(3_000)
    await save.click()
    expect(writes).toBe(1)
    await page.clock.runFor(2_100)
    await expect(save).toHaveAttribute('data-save-state', 'idle')
    // Une modification retire la coche immédiatement ; Undo ne la fait pas réapparaître.
    await editor.fill('Suite')
    await save.click()
    await expect(save).toHaveAttribute('data-save-state', 'success')
    await editor.fill('Encore')
    await expect(save).toHaveAttribute('data-save-state', 'pending')
    await editor.press('Control+z')
    await expect(save).toHaveAttribute('data-save-state', 'idle')
  })
}

test('écriture concurrente à la saisie : aucune coche partielle, confirmation suivante et onglet masqué', async ({ page }) => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let stored = { video_id: 1, content_md: 'Initial', revision: 1, created_at: '2026-10-01', updated_at: '2026-10-21T12:34:56Z' }
  let writes = 0
  await page.route('**/api/v1/videos/1/note', async route => {
    if (route.request().method() === 'PUT') {
      writes++
      const content = route.request().postDataJSON().content_md
      if (writes === 1) await gate
      stored = { ...stored, content_md: content, revision: stored.revision + 1 }
    }
    await route.fulfill({ json: stored })
  })
  await page.clock.install()
  await page.goto('/videos/1')
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  const save = page.locator('.note-save button')
  await editor.fill('Premier envoi')
  const node = await editor.elementHandle()
  await save.click()
  await expect(save).toHaveAttribute('data-save-state', 'saving')
  await editor.fill('Texte plus récent')
  release()
  await expect(save).toHaveAttribute('data-save-state', 'pending')
  await expect(page.locator('.note-save [role=tooltip]')).toContainText('révision 2')
  await page.clock.runFor(2_100)
  await expect(save).toHaveAttribute('data-save-state', 'success')
  expect(stored.content_md).toBe('Texte plus récent')
  expect(writes).toBe(2)
  expect(await node!.evaluate(element => element === document.querySelector('.cm-content'))).toBe(true)
  await page.getByRole('tab', { name: 'Informations', exact: true }).click()
  await page.clock.runFor(5_100)
  await page.getByRole('tab', { name: 'Note', exact: true }).click()
  await expect(save).toHaveAttribute('data-save-state', 'idle')
})

for (const failure of [400, 409]) {
  test('échec persistant et résolution accessible : ' + failure, async ({ page }) => {
    let fail = true
    let stored = { video_id: 1, content_md: 'Initial', revision: 1, created_at: '2026-10-01', updated_at: '2026-10-21T12:34:56Z' }
    await page.route('**/api/v1/videos/1/note', async route => {
      if (route.request().method() === 'PUT') {
        if (fail) {
          await route.fulfill({ status: failure, json: { error: { code: failure === 409 ? 'note_conflict' : 'bad_request' } } })
          return
        }
        stored = { ...stored, content_md: route.request().postDataJSON().content_md, revision: stored.revision + 1 }
      }
      await route.fulfill({ json: stored })
    })
    await page.clock.install()
    await page.goto('/videos/1')
    await page.getByRole('textbox', { name: 'Note Markdown' }).fill('Local')
    const save = page.locator('.note-save button')
    await save.click()
    await expect(save).toHaveAttribute('data-save-state', failure === 409 ? 'conflict' : 'error')
    await page.clock.runFor(6_000)
    await expect(save).toHaveAttribute('data-save-state', failure === 409 ? 'conflict' : 'error')
    await expect(page.getByLabel('État de la note')).toBeVisible()
    if (failure === 409) {
      await save.click()
      await expect(page.getByRole('region', { name: 'Résolution du conflit' })).toBeFocused()
      await page.getByRole('button', { name: 'Conserver la version serveur' }).click()
      await expect(save).toHaveAttribute('data-save-state', 'idle')
    } else {
      fail = false
      await save.click()
      await expect(save).toHaveAttribute('data-save-state', 'success')
    }
  })
}

test('réponse perdue : la réconciliation confirme sans seconde écriture', async ({ page }) => {
  let stored = { video_id: 1, content_md: 'Initial', revision: 1, created_at: '2026-10-01', updated_at: '2026-10-21T12:34:56Z' }
  let writes = 0
  await page.route('**/api/v1/videos/1/note', async route => {
    if (route.request().method() === 'PUT') {
      writes++
      stored = { ...stored, content_md: route.request().postDataJSON().content_md, revision: 2 }
      await route.abort('failed')
    } else await route.fulfill({ json: stored })
  })
  await page.clock.install()
  await page.goto('/videos/1')
  await page.getByRole('textbox', { name: 'Note Markdown' }).fill('Envoi')
  const save = page.locator('.note-save button')
  await save.click()
  await expect.poll(() => writes).toBe(1)
  await expect(save).toHaveAttribute('data-save-state', 'saving')
  await page.clock.runFor(1_100)
  await expect(save).toHaveAttribute('data-save-state', 'success')
  expect(writes).toBe(1)
})

test('note absente : création explicite vide confirmée une seule fois', async ({ page }) => {
  let stored: object | null = null
  let writes = 0
  await page.route('**/api/v1/videos/1/note', async route => {
    if (route.request().method() === 'PUT') {
      writes++
      expect(route.request().postDataJSON()).toEqual({ content_md: '', expected_revision: 0 })
      stored = { video_id: 1, content_md: '', revision: 1, created_at: '2026-10-21', updated_at: '2026-10-21T12:34:56Z' }
    }
    if (stored) await route.fulfill({ json: stored })
    else await route.fulfill({ status: 404, json: { error: { code: 'note_not_found' } } })
  })
  await page.clock.install()
  await page.goto('/videos/1')
  const save = page.locator('.note-save button')
  await expect(save).toHaveAttribute('data-save-state', 'idle')
  await save.click()
  await expect(save).toHaveAttribute('data-save-state', 'success')
  await page.clock.runFor(5_100)
  await save.click()
  await expect(save).toHaveAttribute('data-save-state', 'idle')
  expect(writes).toBe(1)
})
