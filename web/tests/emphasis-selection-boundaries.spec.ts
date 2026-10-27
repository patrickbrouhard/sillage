import type { Locator } from '@playwright/test'
import { test, expect } from './fixtures'
import { openEditor, selection, copy, wordPoint } from './editorTestHelpers'

/** Vise un bord du texte rendu ; les offsets source proviennent uniquement de la sonde. */
async function textEdge(line: Locator, edge: 'left' | 'right', delta: number) {
  return line.evaluate((element, { edge, delta }) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const box = range.getBoundingClientRect()
    return { x: box[edge] + delta, y: box.y + box.height / 2 }
  }, { edge, delta })
}

test('double clic après le bord droit : dernier mot visible, menu et Undo/Redo', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 })
  const text = 'before\n**Alpha***Beta*\nafter'
  const { editor, writes } = await openEditor(page, text)
  const line = editor.locator('.cm-line').nth(1)
  await expect(line).toHaveText('AlphaBeta')
  const point = await textEdge(line, 'right', 1)
  await page.mouse.dblclick(point.x, point.y, { delay: 120 })
  expect(await selection(editor)).toMatchObject({ anchor: 17, head: 21, text: 'Beta', doc: text })
  expect(await copy(editor)).toBe('Beta')
  expect(writes).toEqual([])
  const toolbar = page.getByRole('toolbar', { name: 'Mise en forme Markdown' })
  await expect(toolbar).toBeVisible()
  await toolbar.getByRole('button', { name: 'Italique', exact: true }).click()
  const changed = 'before\n**Alpha**Beta\nafter'
  expect(await selection(editor)).toMatchObject({ text: 'Beta', doc: changed })
  await page.keyboard.press('Control+z')
  expect((await selection(editor)).doc).toBe(text)
  await page.keyboard.press('Control+Shift+z')
  expect(await selection(editor)).toMatchObject({ text: 'Beta', doc: changed })
})

for (const sample of [
  { name: 'juste avant le bord droit', body: '**Alpha***Beta*', edge: 'right', delta: -1, word: 'Beta' },
  { name: 'avant le bord gauche', body: '**Alpha***Beta*', edge: 'left', delta: -1, word: 'Alpha' },
  { name: 'imbrication Unicode en fin de titre', body: '###### **Alpha*****cafe\u0301_中文***', edge: 'right', delta: 1, word: 'cafe\u0301_中文' },
]) {
  test('graphème visible initial : ' + sample.name, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 800 })
    const text = 'before\n' + sample.body + '\nafter'
    const { editor, writes } = await openEditor(page, text)
    const point = await textEdge(editor.locator('.cm-line').nth(1), sample.edge as 'left' | 'right', sample.delta)
    await page.mouse.dblclick(point.x, point.y, { delay: 120 })
    const from = text.indexOf(sample.word)
    expect(await selection(editor)).toMatchObject({ anchor: from, head: from + sample.word.length, text: sample.word, doc: text })
    expect(await copy(editor)).toBe(sample.word)
    expect(writes).toEqual([])
  })
}

for (const reversed of [false, true]) {
  test('glisser par mots aux bords : plage source conservée, inversé=' + reversed, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 800 })
    const text = 'before\n**Alpha***Beta*\nafter'
    const { editor, writes } = await openEditor(page, text)
    const line = editor.locator('.cm-line').nth(1)
    const alpha = await wordPoint(line, 'Alpha')
    const beta = await wordPoint(line, 'Beta')
    const left = await textEdge(line, 'left', -1)
    const right = await textEdge(line, 'right', 1)
    const start = reversed ? beta : alpha
    const end = reversed ? left : right
    await page.mouse.click(start.x, start.y)
    await page.waitForTimeout(120)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down({ clickCount: 2 })
    await page.mouse.move(end.x, end.y, { steps: 8 })
    await expect(line).toHaveText('AlphaBeta')
    await page.mouse.up()
    expect(await selection(editor)).toMatchObject({
      anchor: reversed ? 21 : 9,
      head: reversed ? 9 : 21,
      text: 'Alpha***Beta',
      doc: text,
    })
    expect(await copy(editor)).toBe('Alpha***Beta')
    expect(writes).toEqual([])
  })
}
