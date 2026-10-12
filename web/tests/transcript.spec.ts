import { expect, test } from '@playwright/test'
import { groupTranscript } from '../src/transcriptPresentation'

test('regroupe sans réordonner, découper les mots ou perdre les blancs', () => {
  const items = [
    { start_ms: 0, text: ' \n' },
    { start_ms: 5100, text: 'Bon' },
    { start_ms: 5100, text: 'jour' },
    { start_ms: 9999, text: ' le' },
    { start_ms: 10000, text: ' monde' },
    { start_ms: 9000, text: ' !' },
    { start_ms: 25000, text: '\n ' },
    { start_ms: 60000, text: 'Suite' },
  ]
  const copy = structuredClone(items)
  const blocks = groupTranscript(items, 5)
  expect(blocks).toEqual([
    { start_ms: 5100, text: ' \nBonjour le' },
    { start_ms: 10000, text: ' monde' },
    { start_ms: 9000, text: ' !\n ' },
    { start_ms: 60000, text: 'Suite' },
  ])
  expect(blocks.map(block => block.text).join('')).toBe(items.map(item => item.text).join(''))
  expect(items).toEqual(copy)
  expect(groupTranscript([{ start_ms: 0, text: '\n  ' }], 10)).toEqual([])
  expect(groupTranscript([], 10)).toEqual([])
})

test('acquiert via Go/SQLite et relit localement sans POST à ouverture', async ({ page, request }, info) => {
  const externalID = `tr00000000${info.retry}`
  const video = await (await request.post('/api/v1/videos', { data: { url: `https://youtu.be/${externalID}` } })).json()
  const url = `/api/v1/videos/${video.id}/sources/${video.sources[0].id}/transcript`
  let posts = 0
  page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/transcript')) posts++ })
  await page.goto(`/videos/${video.id}`)
  await expect(page.getByText('Aucune transcription enregistrée localement.')).toBeVisible()
  expect(posts).toBe(0)
  await page.getByRole('button', { name: 'Récupérer', exact: true }).click()
  await expect(page.getByLabel('Texte de la transcription')).toContainText('Bonjour le monde.')
  await expect(page.locator('.transcript-block')).toHaveCount(2)
  const stored = await (await request.get(url)).json()
  expect(stored.language).toBe('fr')
  expect(stored.items[0]).toEqual({ start_ms: 2960, text: 'Bon' })
  await page.getByLabel('Intervalle').selectOption('15')
  await expect(page.locator('.transcript-block')).toHaveCount(1)
  await page.reload()
  await expect(page.locator('.transcript-block')).toHaveCount(2)
  expect(posts).toBe(1)
  await page.getByRole('button', { name: 'Actualiser', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Actualiser', exact: true })).toBeEnabled()
  expect(posts).toBe(2)
})

for (const [code, status, message] of [
  ['transcript_not_available', 404, 'Aucune transcription automatique originale'],
  ['transcript_fetch_failed', 502, 'auprès de YouTube'],
  ['transcript_fetch_timeout', 504, 'délai de récupération'],
  ['internal_error', 500, 'erreur interne'],
] as const) {
  test(`conserve le contenu pendant et après ${code}`, async ({ page }) => {
    await page.route('**/api/v1/videos/42', route => route.fulfill({ json: {
      id: 42, created_at: '2026-10-12', tags: [], person_ids: [],
      sources: [{ id: 17, provider: 'youtube', external_id: 'abcdefghijk', title: 'Test' }],
    } }))
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    await page.route('**/transcript', async route => {
      if (route.request().method() === 'POST') {
        await pending
        await route.fulfill({ status, json: { error: { code } } })
      } else await route.fulfill({ json: {
        language: 'fr', provenance: 'youtube_auto', last_fetched_at: '2026-10-12T10:00:00Z',
        items: [{ start_ms: 1234, text: 'Texte conservé' }],
      } })
    })
    await page.goto('/videos/42')
    await expect(page.getByText('Texte conservé', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Actualiser', exact: true }).click()
    await expect(page.getByText('Actualisation en cours…')).toBeVisible()
    await expect(page.getByText('Texte conservé', { exact: true })).toBeVisible()
    release()
    await expect(page.getByRole('alert')).toContainText(message)
    await expect(page.getByText('Texte conservé', { exact: true })).toBeVisible()
  })
}
