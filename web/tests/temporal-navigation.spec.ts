import { expect, test } from './fixtures'
import type { Page } from '@playwright/test'
import { parseTemporalReference } from '../src/temporalReference'

const uri = 'sillage://videos/42/sources/17?start_ms=12750'

/** Installe une note et une source déterministes sans modifier de données personnelles. */
async function workspace(page: Page, content = '[Libellé indépendant](' + uri + ')') {
  await page.route('**/api/v1/videos/42', route => route.fulfill({ json: {
    id: 42, created_at: '2026-10-12', tags: [], person_ids: [],
    sources: [{ id: 17, provider: 'youtube', external_id: 'abcdefghijk', title: 'Vidéo test',
      canonical_url: 'https://www.youtube.com/watch?v=abcdefghijk' }],
  } }))
  await page.route('**/note', route => route.fulfill({ json: {
    video_id: 42, content_md: content, revision: 1, updated_at: '2026-10-12',
  } }))
  await page.route('**/transcript', route => route.fulfill({ json: {
    language: 'fr', provenance: 'youtube_auto', last_fetched_at: '2026-10-12',
    items: [{ start_ms: 12750, text: 'Passage commun' }],
  } }))
  await page.goto('/videos/42')
  await expect(page.getByRole('textbox', { name: 'Note Markdown' })).toBeVisible()
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await expect(page.locator('.markdown-reading')).toBeVisible()
}

const invalid = [
  '', uri + '&end_ms=15000', uri + '&x=1', uri + '&start_ms=2', uri + '#x',
  uri + '/', uri + '\n', uri + ' ', uri.replace('videos/', 'videos:80/'),
  uri.replace('videos/', 'user@videos/'), uri.replace('/42/', '/0/'),
  uri.replace('/42/', '/042/'), uri.replace('/42/', '/%34%32/'),
  uri.replace('/17?', '/0?'), uri.replace('/17?', '/017?'),
  uri.replace('/42/', '/9007199254740992/'),
  uri.replace('/17?', '/9007199254740992?'),
  ...['-1', '+1', '01', '1.5', '1e3', '', '9007199254740992', '%31']
    .map(value => uri.replace('12750', value)),
  uri.replace('sillage:', 'SILLAGE:'), uri.replace('videos/', 'VIDEOS/'),
  uri.replace('/sources/', '/other/'), uri.replace('?start_ms', '/extra?start_ms'),
]

test('parse uniquement les URI canoniques et les entiers sûrs', () => {
  expect(parseTemporalReference(uri)).toEqual({ videoID: 42, sourceID: 17, startMs: 12750 })
  expect(parseTemporalReference(uri.replace('12750', '0'))?.startMs).toBe(0)
  expect(parseTemporalReference(uri.replace('12750', '9007199254740991'))?.startMs).toBe(Number.MAX_SAFE_INTEGER)
  for (const value of invalid) expect(parseTemporalReference(value), value).toBeNull()
})

test('rendu ciblé, contenu invalide inerte, images et liens ordinaires protégés', async ({ page }) => {
  await workspace(page, [
    '[Autre libellé](' + uri + ')',
    ...invalid.filter(value => value && !/\s/.test(value)).map(value => '[Invalide](<' + value + '>)'),
    '[Dangereux](javascript:alert%281%29)',
    '![Image Sillage](' + uri + ')',
    '[Externe](https://example.org/path)',
    'https://example.org/auto',
    '[HTTP](http://example.org/plain)',
    '[Interne](/videos/43)',
    '[Même origine](http://127.0.0.1:18381/videos/43)',
    '[Courriel](mailto:a@example.org)',
    '<script>alert(1)</script>',
  ].join('\n\n'))
  const reading = page.getByLabel('Lecture de la note')
  await expect(reading.getByRole('button')).toHaveCount(1)
  await expect(reading.getByRole('button')).toHaveText('Autre libellé')
  await expect(reading.getByRole('button')).toHaveAccessibleName('Autre libellé')
  await expect(reading.getByRole('button')).toHaveAccessibleDescription('Aller à 0:12 dans le lecteur')
  await expect(reading.locator('a[href^="sillage:"], a[href^="javascript:"]')).toHaveCount(0)
  await expect(reading.locator('img[src^="sillage:"]')).toHaveCount(0)
  await expect(reading.locator('script')).toHaveCount(0)
  await expect(reading.getByRole('link', { name: 'Externe' })).toHaveAttribute('href', 'https://example.org/path')
  await expect(reading.getByRole('link', { name: 'Interne' })).toHaveAttribute('href', '/videos/43')
  await expect(reading.getByRole('link', { name: 'Courriel' })).toHaveAttribute('href', 'mailto:a@example.org')
  for (const name of ['Externe', 'https://example.org/auto', 'HTTP']) {
    const link = reading.getByRole('link', { name, exact: true })
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  }
  for (const name of ['Interne', 'Même origine', 'Courriel']) {
    await expect(reading.getByRole('link', { name, exact: true })).not.toHaveAttribute('target')
  }
  // Navigation réelle dans un onglet isolé, sans accès au site externe.
  await page.context().route('https://example.org/**', route => route.fulfill({
    contentType: 'text/html', body: '<title>Destination de test</title>',
  }))
  for (const name of ['Externe', 'https://example.org/auto']) {
    const popupPromise = page.waitForEvent('popup')
    await reading.getByRole('link', { name, exact: true }).click()
    const popup = await popupPromise
    await popup.waitForLoadState()
    expect(await popup.evaluate(() => window.opener)).toBeNull()
    await expect(page).toHaveURL(/\/videos\/42$/)
    await popup.close()
  }
})

for (const state of [-1, 0, 1, 2, 3, 5]) {
  test('note et transcription partagent la commande, état ' + state, async ({ page }) => {
    await workspace(page)
    await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
    const note = page.getByLabel('Lecture de la note').getByRole('button')
    const transcript = page.getByLabel('Texte de la transcription').getByRole('button')
    for (const button of [note, transcript]) {
      await page.evaluate(value => window.youtubeTest.players.at(-1)!.emitState(value), state)
      await button.focus()
      await button.press('Enter')
      await expect(button).toBeFocused()
      const result = await page.evaluate(() => {
        const player = window.youtubeTest.players.at(-1)!
        return { position: player.position, state: player.state, call: player.navigationCalls.at(-1) }
      })
      expect(result.position).toBe(12.75)
      expect(result.state).toBe([-1, 0, 5].includes(state) ? 5 : state === 2 ? 2 : 1)
      expect(result.call?.command).toBe([-1, 0, 5].includes(state) ? 'cue' : 'seek')
    }
  })
}

test('identités différentes : message près du bouton, sans commande ni changement de fiche', async ({ page }) => {
  await workspace(page, '[Vidéo](' + uri.replace('/42/', '/43/') + ')\n\n[Source](' + uri.replace('/17?', '/18?') + ')')
  const reading = page.getByLabel('Lecture de la note')
  for (const [index, text] of ['autre vidéo', 'autre source'].entries()) {
    await reading.getByRole('button').nth(index).click()
    await expect(reading.getByRole('button').nth(index).locator('..').getByRole('status')).toContainText(text)
    expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
    await expect(page).toHaveURL(/\/videos\/42$/)
  }
})

test('masqué conservé : réaffiche sans reprendre et garde le focus', async ({ page }) => {
  await workspace(page)
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(1))
  await page.getByRole('button', { name: 'Masquer le lecteur' }).click()
  const button = page.getByLabel('Lecture de la note').getByRole('button')
  await button.click()
  await expect(button).toBeFocused()
  await expect(page.locator('.youtube-frame iframe')).toBeVisible()
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.state)).toBe(2)
})

for (const width of [1440, 375]) {
  test('défilement réel conditionnel, sans déplacement des panneaux, largeur ' + width, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await workspace(page, '[Temps](' + uri + ')\n\n' + 'Longue note.\n\n'.repeat(60))
    await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
    for (const from of ['.markdown-reading button', '.transcript-time']) {
      for (const mode of ['visible', 'partial', 'above', 'oversize']) {
        const before = await page.evaluate(({ from, mode }) => {
          const host = document.querySelector<HTMLElement>('.youtube-frame')!
          host.style.height = mode === 'oversize' ? '1000px' : '200px'
          host.style.aspectRatio = 'auto'
          const y = host.getBoundingClientRect().top + window.scrollY
          window.scrollTo(0, mode === 'visible' ? y - 10 : mode === 'partial' ? y - innerHeight + 100 : y + 100)
          document.querySelector<HTMLElement>('.workspace-note')!.scrollTop = 70
          const button = document.querySelector<HTMLButtonElement>(from)!
          button.focus({ preventScroll: true })
          return {
            y: scrollY, note: document.querySelector('.workspace-note')!.scrollTop,
            transcript: document.querySelector('.transcript-content')!.scrollTop,
          }
        }, { from, mode })
        // click DOM volontaire : aucune mise en visibilité automatique de Playwright.
        await page.locator(from).evaluate((button: HTMLButtonElement) => button.click())
        const after = await page.evaluate(() => {
          const bounds = document.querySelector('.youtube-frame')!.getBoundingClientRect()
          return { y: scrollY, top: bounds.top, bottom: bounds.bottom, height: innerHeight,
            note: document.querySelector('.workspace-note')!.scrollTop,
            transcript: document.querySelector('.transcript-content')!.scrollTop }
        })
        expect(after.note).toBe(before.note)
        expect(after.transcript).toBe(before.transcript)
        await expect(page.locator(from)).toBeFocused()
        if (mode === 'visible') expect(after.y).toBe(before.y)
        else if (mode === 'oversize') expect(Math.abs(after.top)).toBeLessThan(2)
        else {
          expect(after.top).toBeGreaterThanOrEqual(-1)
          expect(after.bottom).toBeLessThanOrEqual(after.height + 1)
        }
      }
    }
  })
}

test('refus avant disponibilité : aucun scroll ni commande tardive', async ({ page }) => {
  await page.addInitScript(() => { window.youtubeTest = { players: [], autoReady: false, confirmPause: true } })
  await workspace(page)
  await page.evaluate(() => {
    window.scrollTo(0, 100)
    const original = window.scrollBy
    window.scrollBy = (() => { throw new Error('Défilement interdit') }) as typeof original
  })
  const button = page.getByLabel('Lecture de la note').getByRole('button')
  await button.evaluate((element: HTMLButtonElement) => element.click())
  await expect(page.getByLabel('Lecture de la note').getByRole('status')).toContainText('Navigation non effectuée')
  await page.evaluate(() => {
    const player = window.youtubeTest.players.at(-1)!
    player.options.events.onReady({ target: player })
  })
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
})

test('activation en Lecture ne modifie ni note, sélection, Undo ni sauvegarde', async ({ page }) => {
  const writes: string[] = []
  page.on('request', request => { if (request.url().endsWith('/note') && request.method() === 'PUT') writes.push(request.postData()!) })
  await workspace(page)
  await page.getByRole('button', { name: 'Édition', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  const node = await editor.elementHandle()
  await editor.click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.type('X')
  await page.keyboard.press('Shift+ArrowRight')
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  const before = writes.length
  await page.getByLabel('Lecture de la note').getByRole('button').click()
  expect(writes.length).toBe(before)
  await page.getByRole('button', { name: 'Édition', exact: true }).click()
  expect(await node!.evaluate(element => element === document.querySelector('.cm-content'))).toBe(true)
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('[')
  await page.keyboard.press('Control+z')
  await expect(editor.locator('.cm-temporal-reference')).toHaveText('◷Libellé indépendant')
  await expect(page.locator('.markdown-editor button')).toHaveCount(0)
})


for (const failure of ['hiding', 'masked-unavailable', 'exception', 'unknown']) {
  test('navigation refusée sans défilement : ' + failure, async ({ page }) => {
    await workspace(page)
    await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
    if (failure === 'hiding') {
      await page.evaluate(() => {
        window.youtubeTest.confirmPause = false
        window.youtubeTest.players.at(-1)!.emitState(1)
      })
      await page.getByRole('button', { name: 'Masquer le lecteur' }).click()
    } else if (failure === 'masked-unavailable') {
      await page.getByRole('button', { name: 'Masquer le lecteur' }).click()
      await page.evaluate(() => {
        const player = window.youtubeTest.players.at(-1)!
        player.options.events.onError({ data: 100 })
      })
    } else {
      await page.evaluate(failure => {
        const player = window.youtubeTest.players.at(-1)!
        if (failure === 'exception') player.cueVideoById = () => { throw new Error('Échec simulé') }
        else player.state = 99
      }, failure)
    }
    await page.evaluate(() => {
      document.documentElement.dataset.scrolls = '0'
      window.scrollBy = (() => {
        document.documentElement.dataset.scrolls = '1'
      }) as typeof window.scrollBy
    })
    await page.getByLabel('Lecture de la note').getByRole('button').evaluate((button: HTMLButtonElement) => button.click())
    await expect(page.getByLabel('Lecture de la note').getByRole('status')).toContainText(
      failure === 'hiding' ? 'Mise en pause' : 'Navigation non effectuée')
    expect(await page.evaluate(() => document.documentElement.dataset.scrolls)).toBe('0')
    expect(await page.evaluate(() => window.youtubeTest.players.every(p => p.navigationCalls.length === 0))).toBe(true)
    if (failure === 'masked-unavailable') {
      await expect(page.getByRole('button', { name: 'Masquer le lecteur' })).toBeVisible()
      await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
      expect(await page.evaluate(() => window.youtubeTest.players.every(p => p.navigationCalls.length === 0))).toBe(true)
    }
  })
}

test('une fiche sans source utilisable refuse sans transformer la référence en lien externe', async ({ page }) => {
  await workspace(page)
  await page.route('**/api/v1/videos/42', route => route.fulfill({ json: {
    id: 42, created_at: '2026-10-12', tags: [], person_ids: [], sources: [],
  } }))
  await page.reload()
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  const reading = page.getByLabel('Lecture de la note')
  await reading.getByRole('button').click()
  await expect(reading.getByRole('status')).toContainText('aucun lecteur disponible')
  await expect(reading.locator('a')).toHaveCount(0)
})


test('une sauvegarde déjà engagée ne remonte pas le bouton focalisé', async ({ page }) => {
  await workspace(page)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/note', async route => {
    const body = route.request().postDataJSON()
    await gate
    await route.fulfill({ json: {
      video_id: 42, content_md: body.content_md, revision: 2, updated_at: '2026-10-14',
    } })
  })
  await page.getByRole('button', { name: 'Édition', exact: true }).click()
  await page.getByRole('textbox', { name: 'Note Markdown' }).click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' Suite')
  const saving = page.waitForRequest(request => request.method() === 'PUT' && request.url().endsWith('/note'))
  await page.keyboard.press('Control+s')
  await saving
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  const button = page.getByLabel('Lecture de la note').getByRole('button')
  await button.click()
  const node = await button.elementHandle()
  release()
  await expect(page.getByRole('status', { name: 'État de la note' })).toHaveText('Enregistré')
  await expect(button).toBeFocused()
  expect(await node!.evaluate(element => element === document.querySelector('.temporal-reference'))).toBe(true)
})
