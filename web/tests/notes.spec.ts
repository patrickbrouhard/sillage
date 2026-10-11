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
