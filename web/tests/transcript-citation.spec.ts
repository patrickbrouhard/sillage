import { expect, test } from './fixtures'
import type { APIRequestContext, Page } from '@playwright/test'
import { extractTranscript, transcriptCitation } from '../src/transcriptSelection'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { remarkCallouts } from '../src/remarkCallouts'

const fragments = [
  { start_ms: 0, text: 'Préambule ' },
  { start_ms: 1234, text: '  Bon' },
  { start_ms: 1500, text: 'jour' },
  { start_ms: 10000, text: '\r\n ' },
  { start_ms: 9000, text: '[ami] *fort* <b> &amp; \x60code\x60 https://example.org ' },
  { start_ms: 21000, text: 'fin.' },
]
const sourceText = fragments.map(item => item.text).join('')
const selectedText = 'onjour [ami] *fort* <b> &amp; \x60code\x60 https://example.org'

/** Prépare une vraie session Go/SQLite ; seul le contenu de transcription est déterministe. */
async function openWorkspace(page: Page, request: APIRequestContext, content: string | null = '') {
  const externalID = 'tr64' + test.info().testId.slice(-7)
  const video = await (await request.post('/api/v1/videos', {
    data: { url: 'https://youtu.be/' + externalID },
  })).json()
  const noteURL = '/api/v1/videos/' + video.id + '/note'
  const transcriptURL = '/api/v1/videos/' + video.id + '/sources/' + video.sources[0].id + '/transcript'
  if (content !== null) await request.put(noteURL, { data: { content_md: content, expected_revision: 0 } })
  await page.route('**' + transcriptURL, route => route.fulfill({ json: {
    language: 'fr', provenance: 'youtube_auto', last_fetched_at: '2026-10-14T10:00:00Z',
    items: fragments,
  } }))
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/videos/' + video.id)
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  await expect(page.locator('[data-transcript-text]')).toHaveCount(3)
  await expect(page.getByText('Chargement du lecteur YouTube…')).toHaveCount(0)
  return { editor, noteURL, transcriptURL, video }
}

/** Place une sélection native en offsets source, y compris sous les mark et à rebours. */
async function selectText(page: Page, start = sourceText.indexOf('Bon') + 1, end = sourceText.indexOf('fin.'), backwards = false) {
  await page.getByLabel('Texte de la transcription', { exact: true }).focus()
  await page.evaluate(({ start, end, backwards }) => {
    const nodes: Text[] = []
    for (const p of document.querySelectorAll('[data-transcript-text]')) {
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
    }
    function boundary(offset: number): [Text, number] {
      for (const node of nodes) {
        if (offset <= node.length) return [node, offset]
        offset -= node.length
      }
      throw new Error('Offset hors transcription')
    }
    const a = boundary(start)
    const b = boundary(end)
    window.getSelection()!.setBaseAndExtent(...(backwards ? b : a), ...(backwards ? a : b))
  }, { start, end, backwards })
  await expect(page.getByRole('button', { name: 'Citer dans la note' })).toBeEnabled()
}

/** Lit le contenu confirmé sans dépendre du rendu des fins de ligne CodeMirror. */
async function saved(request: APIRequestContext, noteURL: string) {
  return (await (await request.get(noteURL)).json()).content_md
}

test('extraction partielle, blancs et ordre source sans interpolation', () => {
  const copy = structuredClone(fragments)
  expect(extractTranscript(fragments, sourceText.indexOf('Bon') + 1, sourceText.indexOf('fin.')))
    .toEqual({ text: selectedText, startMs: 1234 })
  expect(extractTranscript(fragments, sourceText.indexOf('\r'), sourceText.length))
    .toEqual({ text: '[ami] *fort* <b> &amp; \x60code\x60 https://example.org fin.', startMs: 9000 })
  expect(extractTranscript(fragments, sourceText.indexOf('\r'), sourceText.indexOf('['))).toBeNull()
  expect(fragments).toEqual(copy)
})

test('Markdown littéral, en-tête de transcription et référence sans libellé ni fin', () => {
  const markdown = transcriptCitation({ text: selectedText, startMs: 1234 }, 5, 7)
  const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkCallouts], skipHtml: true }, markdown))
  expect(html).toContain('data-callout="quote:tr"')
  expect(markdown).toMatch(/^> \[!quote:tr\]\(sillage:\/\/videos\/5\/sources\/7\?start_ms=1234\)\n> /)
  expect(markdown).not.toContain('[0:01]')
  expect(html).not.toMatch(/<(strong|em|code|b)>/)
  expect(html).toContain('[ami] *fort* &lt;b&gt; &amp;amp;')
  expect(html).toContain('https://example.org</a>') // GFM conserve ses autoliens sans changer les mots.
  expect(markdown).toContain('sillage://videos/5/sources/7?start_ms=1234')
  expect(markdown).not.toContain('end_ms')
})

for (const backwards of [false, true]) {
  test('copie native entre blocs avec recherche, sélection inversée : ' + backwards, async ({ page, request }) => {
    await openWorkspace(page, request)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.getByRole('searchbox').fill('jour')
    await selectText(page, undefined, undefined, backwards)
    await page.keyboard.press('Control+c')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(selectedText)
    expect((await page.locator('[data-transcript-text]').allTextContents()).join('')).toBe(sourceText)
    expect(await page.locator('.transcript-time').first().evaluate(e => getComputedStyle(e).userSelect)).toBe('none')
  })
}

test('note absente : citation à zéro, autosauvegarde et lecteur inchangé', async ({ page, request }) => {
  const { editor, noteURL, video } = await openWorkspace(page, request, null)
  expect((await request.get(noteURL)).status()).toBe(404)
  const node = await editor.elementHandle()
  const before = await page.evaluate(() => {
    const p = window.youtubeTest.players.at(-1)!
    return { state: p.state, pauses: p.pauseCalls, calls: p.navigationCalls, position: p.position }
  })
  await selectText(page)
  await page.getByRole('button', { name: 'Citer dans la note' }).click()
  await expect(editor).toBeFocused()
  const expected = transcriptCitation({ text: selectedText, startMs: 1234 }, video.id, video.sources[0].id) + '\n\n'
  await expect.poll(() => saved(request, noteURL)).toBe(expected)
  expect(await node!.evaluate(e => e === document.querySelector('.cm-content'))).toBe(true)
  expect(await page.evaluate(() => {
    const p = window.youtubeTest.players.at(-1)!
    return { state: p.state, pauses: p.pauseCalls, calls: p.navigationCalls, position: p.position }
  })).toEqual(before)
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  const callout = page.locator('.quote-callout')
  await expect(callout).toHaveAccessibleName('Citation de transcription')
  await expect(callout.locator('.quote-callout-body')).toHaveText(selectedText)
  await expect(callout.getByRole('button')).toHaveText('0:01')
  await callout.getByRole('button').click()
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls.at(-1)?.seconds)).toBe(1.234)
  await page.reload()
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await expect(page.locator('.quote-callout-body')).toHaveText(selectedText)
  expect(await saved(request, noteURL)).toBe(expected)
})

for (const content of ['Note existante', '   ']) {
  test('refuse sans position choisie : ' + JSON.stringify(content), async ({ page, request }) => {
    const { noteURL } = await openWorkspace(page, request, content)
    await page.getByRole('button', { name: 'Lecture', exact: true }).click()
    await page.getByRole('button', { name: 'Édition', exact: true }).click()
    await selectText(page)
    await page.getByRole('button', { name: 'Citer dans la note' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Placez le curseur' })).toBeVisible()
    expect(await saved(request, noteURL)).toBe(content)
    await expect(page.getByRole('button', { name: 'Citer dans la note' })).toBeDisabled()
  })
}

test('Lecture : refus sans bascule ni insertion différée', async ({ page, request }) => {
  const { editor, noteURL } = await openWorkspace(page, request, 'Note')
  await editor.click()
  await page.getByRole('button', { name: 'Lecture', exact: true }).click()
  await selectText(page)
  await page.getByRole('button', { name: 'Citer dans la note' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Passez en Édition' })).toBeVisible()
  await expect(editor).toBeHidden()
  await page.getByRole('button', { name: 'Édition', exact: true }).click()
  expect(await saved(request, noteURL)).toBe('Note')
  await expect(page.getByRole('button', { name: 'Citer dans la note' })).toBeDisabled()
})

for (const backwards of [false, true]) {
  test('sélection de note inversée : ' + backwards + ', focus clavier et Undo isolé', async ({ page, request }) => {
    const { editor, noteURL, video } = await openWorkspace(page, request, 'alpha omega')
    await editor.click()
    await page.keyboard.press('Control+Home')
    await page.keyboard.type('X')
    if (backwards) {
      for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
      for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft')
    } else {
      for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight')
    }
    await selectText(page)
    const button = page.getByRole('button', { name: 'Citer dans la note' })
    await page.keyboard.press('Shift+Tab')
    await expect(button).toBeFocused()
    await button.press('Enter')
    const quote = transcriptCitation({ text: selectedText, startMs: 1234 }, video.id, video.sources[0].id)
    const expected = 'Xalpha\n\n' + quote + '\n\n omega'
    await expect(editor).toBeFocused()
    await page.keyboard.press('Control+s')
    await expect.poll(() => saved(request, noteURL)).toBe(expected)
    await page.keyboard.type('suite')
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    await expect(editor).toHaveText('Xalpha omega')
    await page.keyboard.press('Control+Shift+Z')
    await page.keyboard.press('Control+s')
    await expect.poll(() => saved(request, noteURL)).toBe(expected)
  })
}

test('sélection obsolète après recherche et actualisation ; copie externe non interceptée', async ({ page, request }) => {
  await openWorkspace(page, request)
  const button = page.getByRole('button', { name: 'Citer dans la note' })
  await selectText(page)
  await page.getByRole('searchbox').fill('ami')
  await expect(button).toBeDisabled()
  await selectText(page)
  await page.getByRole('button', { name: 'Actualiser', exact: true }).click()
  await expect(button).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Actualiser', exact: true })).toBeEnabled()
  const intercepted = await page.getByRole('heading', { name: 'Transcription', exact: true }).evaluate(element => {
    const range = document.createRange()
    range.selectNodeContents(element)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() })
    element.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(intercepted).toBe(false)
  await expect(button).toBeDisabled()
})


test('clic à zéro constitue un choix explicite sans saisie préalable', async ({ page, request }) => {
  const { editor, noteURL, video } = await openWorkspace(page, request, 'Suite')
  await editor.click()
  await page.keyboard.press('Control+Home')
  await selectText(page)
  await page.getByRole('button', { name: 'Citer dans la note' }).click()
  await page.keyboard.press('Control+s')
  const quote = transcriptCitation({ text: selectedText, startMs: 1234 }, video.id, video.sources[0].id)
  await expect.poll(() => saved(request, noteURL)).toBe(quote + '\n\nSuite')
})

test('une insertion temporelle programmée ne choisit pas implicitement un emplacement', async ({ page, request }) => {
  const { noteURL } = await openWorkspace(page, request, 'Suite')
  await page.evaluate(() => window.youtubeTest.players.at(-1)!.emitState(2))
  await page.getByRole('button', { name: '+ Temps', exact: true }).click()
  await selectText(page)
  await page.getByRole('button', { name: 'Citer dans la note' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Placez le curseur' })).toBeVisible()
  await page.getByRole('button', { name: 'Enregistrer la note', exact: true }).click()
  await expect.poll(() => saved(request, noteURL)).toContain('](')
  expect(await saved(request, noteURL)).not.toContain('> ')
})

for (const keepLocal of [false, true]) {
  test('conflit après citation, conservation locale : ' + keepLocal, async ({ page, request }) => {
    const { editor, noteURL } = await openWorkspace(page, request, 'Version initiale')
    await editor.click()
    await page.keyboard.press('Control+End')
    await request.put(noteURL, { data: { content_md: 'Version distante', expected_revision: 1 } })
    await selectText(page)
    await page.getByRole('button', { name: 'Citer dans la note' }).click()
    await page.keyboard.press('Control+s')
    await expect(page.getByRole('region', { name: 'Résolution du conflit' })).toBeVisible()
    expect(await saved(request, noteURL)).toBe('Version distante')
    await expect(editor).toContainText('onjour')
    if (keepLocal) {
      await page.getByRole('button', { name: 'Conserver ma version locale' }).click()
      await expect.poll(() => saved(request, noteURL)).toContain('onjour')
      await expect(page.getByRole('region', { name: 'Résolution du conflit' })).toHaveCount(0)
    } else {
      await page.getByRole('button', { name: 'Conserver la version serveur' }).click()
      await expect(editor).toHaveText('Version distante')
      await selectText(page)
      await page.getByRole('button', { name: 'Citer dans la note' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Placez le curseur' })).toBeVisible()
      expect(await saved(request, noteURL)).toBe('Version distante')
    }
  })
}

test('sélection réelle à la souris à travers plusieurs blocs puis copie native', async ({ page, request }) => {
  await openWorkspace(page, request)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.getByRole('button', { name: 'Masquer la vidéo' }).click()
  await page.getByLabel('Texte de la transcription', { exact: true }).scrollIntoViewIfNeeded()
  const points = await page.locator('[data-transcript-text]').evaluateAll(paragraphs => {
    function point(element: Element, atEnd: boolean) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      const nodes: Text[] = []
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
      const node = atEnd ? nodes.at(-1)! : nodes[0]
      const range = document.createRange()
      range.setStart(node, atEnd ? node.length - 1 : 0)
      range.setEnd(node, atEnd ? node.length : 1)
      const box = range.getBoundingClientRect()
      return { x: atEnd ? box.right : box.left, y: box.top + box.height / 2 }
    }
    return { start: point(paragraphs[0], false), end: point(paragraphs.at(-1)!, true) }
  })
  await page.mouse.move(points.start.x, points.start.y)
  await page.mouse.down()
  await page.mouse.move(points.end.x, points.end.y, { steps: 20 })
  await page.mouse.up()
  await expect(page.getByRole('button', { name: 'Citer dans la note' })).toBeEnabled()
  await page.keyboard.press('Control+c')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(sourceText.trim().replace(/\s+/g, ' '))
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
})

test('écran étroit et lecteur masqué : bouton stable utilisable, aucune reprise', async ({ page, request }, info) => {
  const { editor } = await openWorkspace(page, request)
  await page.getByRole('button', { name: 'Masquer la vidéo' }).click()
  await page.setViewportSize({ width: 375, height: 812 })
  await selectText(page)
  await page.getByRole('button', { name: 'Citer dans la note' }).click()
  await expect(editor).toContainText('onjour')
  await expect(page.locator('.youtube-frame iframe')).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await page.evaluate(() => window.youtubeTest.players.at(-1)!.navigationCalls)).toEqual([])
  await page.screenshot({ path: info.outputPath('citation-mobile.png'), fullPage: true })
})

test('une nouvelle vidéo abandonne la sélection et la position de la précédente', async ({ page, request }) => {
  const { editor } = await openWorkspace(page, request, 'Note')
  const other = await (await request.post('/api/v1/videos', {
    data: { url: 'https://youtu.be/tr65' + test.info().testId.slice(-7) },
  })).json()
  await request.put('/api/v1/videos/' + other.id + '/note', {
    data: { content_md: 'Autre note', expected_revision: 0 },
  })
  await page.route('**/api/v1/videos', route => route.fulfill({ json: { videos: [other] } }))
  await page.route('**/videos/' + other.id + '/sources/*/transcript', route => route.fulfill({ json: {
    language: 'fr', provenance: 'youtube_auto', last_fetched_at: '2026-10-14T10:00:00Z',
    items: fragments,
  } }))
  await editor.click()
  await selectText(page)
  await page.getByRole('link', { name: 'Sillage, accueil' }).click()
  await page.getByRole('link', { name: 'Consulter : ' + other.sources[0].title }).click()
  await expect(editor).toHaveText('Autre note')
  await expect(page.getByRole('button', { name: 'Citer dans la note' })).toBeDisabled()
  await selectText(page)
  await page.getByRole('button', { name: 'Citer dans la note' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Placez le curseur' })).toBeVisible()
})

test('bornes DOM élément et sélection blanche ne capturent ni timestamps ni autre panneau', async ({ page, request }) => {
  await openWorkspace(page, request)
  await page.getByLabel('Texte de la transcription', { exact: true }).focus()
  await page.evaluate(() => {
    const panel = document.querySelector('.transcript-content')!
    const range = document.createRange()
    range.selectNodeContents(panel)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
  })
  await expect(page.getByRole('button', { name: 'Citer dans la note' })).toBeEnabled()
  const copied = await page.evaluate(() => {
    const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() })
    document.querySelector('.transcript-content')!.dispatchEvent(event)
    return event.clipboardData!.getData('text/plain')
  })
  expect(copied).toBe(sourceText.trim().replace(/\s+/g, ' '))
  await page.evaluate(() => {
    const node = document.querySelector('[data-transcript-text]')!.firstChild!
    window.getSelection()!.setBaseAndExtent(node, 9, node, 11)
  })
  await expect(page.getByRole('button', { name: 'Citer dans la note' })).toBeDisabled()
})


for (const position of [5, 7]) {
  test('séparateurs existants conservés, curseur après le bloc, position ' + position, async ({ page, request }) => {
    const { editor, noteURL, video } = await openWorkspace(page, request, 'Avant\n\nAprès')
    await editor.focus()
    await page.keyboard.press('Control+Home')
    for (let i = 0; i < position; i++) await page.keyboard.press('ArrowRight')
    await selectText(page)
    await page.getByRole('button', { name: 'Citer dans la note' }).click()
    await page.keyboard.type('Suite ')
    await page.keyboard.press('Control+s')
    const quote = transcriptCitation({ text: selectedText, startMs: 1234 }, video.id, video.sources[0].id)
    await expect.poll(() => saved(request, noteURL)).toBe('Avant\n\n' + quote + '\n\nSuite Après')
  })
}

test('copie du champ de recherche et de la note non interceptée', async ({ page, request }) => {
  const { editor } = await openWorkspace(page, request, 'Copie de note')
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await selectText(page)
  await editor.focus()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Control+c')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Copie de note')
  const search = page.getByRole('searchbox')
  await search.fill('copie du champ')
  await search.press('Control+a')
  await search.press('Control+c')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('copie du champ')
})

test('une plage mêlant transcription et autre panneau est refusée', async ({ page, request }) => {
  await openWorkspace(page, request)
  await page.evaluate(() => {
    const title = document.querySelector('#transcript-title')!
    const paragraph = document.querySelector('[data-transcript-text]')!
    const range = document.createRange()
    range.setStart(title, 0)
    range.setEnd(paragraph, paragraph.childNodes.length)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
  })
  await expect(page.getByRole('button', { name: 'Citer dans la note' })).toBeDisabled()
})


test('échappement limité et fidélité du paragraphe GFM cité', () => {
  const ordinary = "So, when you go to ollama.com, you can see... C'est (simple) : oui ! A & B > C."
  expect(transcriptCitation({ text: ordinary, startMs: 0 }, 1, 2))
    .toBe('> [!quote:tr](sillage://videos/1/sources/2?start_ms=0)\n> ' + ordinary)

  const examples = [
    ordinary,
    '*fort* **gras** _italique_ a_b_c ~~barré~~ ~seul~',
    '[lien](javascript:alert(1)) ![image](https://example.org/x)',
    '[référence][id] et [id]: https://example.org',
    '\x60code\x60 et \x60\x60deux\x60\x60 et \\*texte\\*',
    '<script>alert(1)</script> <img src=x onerror=alert(1)>',
    '<https://example.org> &amp; &#65; &#x41; &copy; &inconnue;',
    '# Titre', '###### Titre', '####### ordinaire', '> autre citation',
    '- liste', '+ liste', '1. liste', '123456789) liste', '---', '- - -',
    '***', '___', '===', '| colonne | autre |', '[x] tâche', '! ordinaire',
  ]
  for (const text of examples) {
    const result = renderToStaticMarkup(createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, remarkCallouts], skipHtml: true,
    }, transcriptCitation({ text, startMs: 0 }, 1, 2)))
    // Le renderer React échappe le HTML attendu, indépendamment du parseur Markdown.
    const paragraph = renderToStaticMarkup(createElement('p', null, text))
    // Les autoliens GFM sont admis ; aucune autre structure ne doit apparaître.
    const withoutAutolinks = result.replace(/<a\b[^>]*>|<\/a>/g, '')
    expect(withoutAutolinks, text).toContain('\n' + paragraph + '\n</blockquote>')
    expect(result, text).toContain('data-callout="quote:tr"')
    expect(result, text).not.toContain('— ')
  }
})

for (const platform of ['Win32', 'Linux x86_64']) {
  test('Undo et les deux Redo, texte et citation, plateforme CodeMirror ' + platform, async ({ page, request }) => {
    // Exerce la détection de plateforme CodeMirror sous Chromium Linux ;
    // ce n'est pas un essai natif de Windows.
    await page.addInitScript(value => {
      Object.defineProperty(navigator, 'platform', { get: () => value })
    }, platform)
    const { editor, noteURL, video } = await openWorkspace(page, request)
    await editor.click()
    await page.keyboard.type('Texte ordinaire')
    for (const shortcut of ['Control+y', 'Control+Shift+Z']) {
      await page.keyboard.press('Control+z')
      await expect(editor).toHaveText('')
      await page.keyboard.press(shortcut)
      await expect(editor).toHaveText('Texte ordinaire')
    }
    await selectText(page)
    await page.getByRole('button', { name: 'Citer dans la note' }).click()
    const expected = 'Texte ordinaire\n\n'
      + transcriptCitation({ text: selectedText, startMs: 1234 }, video.id, video.sources[0].id)
      + '\n\n'
    for (const shortcut of ['Control+y', 'Control+Shift+Z']) {
      await page.keyboard.press('Control+z')
      await expect(editor).toHaveText('Texte ordinaire')
      await page.keyboard.press(shortcut)
      await page.keyboard.press('Control+s')
      await expect.poll(() => saved(request, noteURL)).toBe(expected)
    }
    // Les deux étapes restent distinctes après tous les cycles Undo/Redo.
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    await expect(editor).toHaveText('')
  })
}
