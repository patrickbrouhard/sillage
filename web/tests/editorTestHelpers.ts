import type { Locator, Page } from '@playwright/test'
import { expect } from './fixtures'
import { build } from 'vite'

let probeScript: Promise<string> | undefined

/** Compile la sonde seule et la partage entre les tests du même worker. */
async function compiledProbe() {
  if (!probeScript) probeScript = buildProbe()
  return probeScript
}

/** Produit un script navigateur sans inclure de code de test dans l'application livrée. */
async function buildProbe() {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: { entry: new URL('./editorProbe.ts', import.meta.url).pathname, name: 'editorProbe', formats: ['iife'] },
    },
  })
  const output = Array.isArray(result) ? result[0] : result
  if (!('output' in output)) throw new Error('Sonde navigateur non compilée')
  return output.output.find(file => file.type === 'chunk')!.code
}

/** Monte la vraie session de note et observe toutes les écritures. */
export async function openEditor(page: Page, initial: string) {
  const writes: string[] = []
  await page.route('**/api/v1/videos/42', route => route.fulfill({ json: {
    id: 42, created_at: '2026-10-15', tags: [], person_ids: [], sources: [],
  } }))
  await page.route('**/note', route => {
    if (route.request().method() === 'PUT') writes.push(route.request().postDataJSON().content_md)
    return route.fulfill({ json: {
      video_id: 42, content_md: writes.at(-1) ?? initial, revision: 1 + writes.length, updated_at: '2026-10-15',
    } })
  })
  await page.goto('/videos/42')
  const editor = page.getByRole('textbox', { name: 'Note Markdown' })
  await expect(editor).toBeVisible()
  await page.addScriptTag({ content: await compiledProbe() })
  return { editor, writes }
}

/** Observe directement la sélection documentaire de la vue CodeMirror réelle. */
export async function selection(editor: Locator) {
  return editor.evaluate(() => window.editorProbe.snapshot())
}

/** Copie par le gestionnaire natif CodeMirror pour vérifier le Markdown documentaire. */
export async function copy(editor: Locator) {
  return editor.evaluate(element => {
    const clipboardData = new DataTransfer()
    element.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }))
    return clipboardData.getData('text/plain')
  })
}

/** Vise le mot compact par un Range DOM ; les assertions utilisent ensuite le document. */
export async function wordPoint(heading: Locator, word: string, fraction = .5) {
  return heading.evaluate((element, { text, fraction }) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = node.textContent!.indexOf(text)
      if (start < 0) continue
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + text.length)
      const box = range.getBoundingClientRect()
      return { x: box.x + box.width * fraction, y: box.y + box.height / 2 }
    }
    throw new Error('Mot absent du titre')
  }, { text: word, fraction })
}
