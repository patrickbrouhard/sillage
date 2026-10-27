import type { Locator } from '@playwright/test'
import { test, expect } from './fixtures'
import { openEditor, selection } from './editorTestHelpers'
import { selectTheme } from './navigationHelpers'

const uri = 'sillage://videos/42/sources/17?start_ms=78546'

/** Compare la pastille et son icône sans confondre leurs interactions propres à chaque mode. */
async function appearance(reference: Locator) {
  return reference.evaluate(element => {
    const content = element.querySelector('.temporal-reference-content') ?? element
    const style = getComputedStyle(content)
    const icon = element.querySelector('.temporal-reference-icon')!
    return {
      color: style.color,
      background: style.backgroundColor,
      padding: style.padding,
      radius: style.borderRadius,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      overflowWrap: style.overflowWrap,
      textDecoration: style.textDecorationLine,
      icon: icon.textContent,
      iconMargin: getComputedStyle(icon).marginRight,
      iconHidden: icon.getAttribute('aria-hidden'),
    }
  })
}

for (const width of [1440, 375]) {
  for (const theme of ['light', 'dark'] as const) {
    test('pastilles partagées en Édition et Lecture, ' + theme + ', largeur=' + width, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 850 })
      const longLabel = 'Un passage descriptif suffisamment long pour se replier sur plusieurs lignes dans une note étroite'
      const text = [
        '[1:18](' + uri + ') et [Un passage descriptif](' + uri + ')',
        '[' + longLabel + '](' + uri + ')',
        '[' + 'UnMotTrèsLong'.repeat(12) + '](' + uri + ')',
        '> [!quote:tr](' + uri + ') Transcription\n> Un extrait cité.',
        '[Lien ordinaire](https://example.org)',
      ].join('\n\n')
      const { editor, writes } = await openEditor(page, text)
      const original = await editor.elementHandle()
      await selectTheme(page, theme)
      await page.mouse.move(0, 0)
      const compact = editor.locator('.cm-temporal-reference')
      await expect(compact).toHaveCount(5)
      const editing = await Promise.all([0, 1, 4].map(index => appearance(compact.nth(index))))
      await compact.first().hover()
      const editingHover = (await appearance(compact.first())).background
      await page.mouse.move(0, 0)
      await page.screenshot({ path: info.outputPath('temporal-editing.png'), fullPage: true })

      await page.getByRole('button', { name: 'Lecture', exact: true }).click()
      const reading = page.getByLabel('Lecture de la note')
      await expect(reading).toBeVisible()
      const references = reading.locator('.temporal-reference')
      await expect(references).toHaveCount(5)
      for (const [position, index] of [0, 1, 4].entries()) {
        expect(await appearance(references.nth(index))).toEqual(editing[position])
      }
      await expect(references.nth(1)).toHaveAccessibleName('Un passage descriptif')
      await expect(references.nth(1)).toHaveAccessibleDescription('Aller à 1:18 dans le lecteur')
      await references.first().hover()
      expect((await appearance(references.first())).background).toBe(editingHover)
      await page.mouse.move(0, 0)
      await expect(reading.getByRole('link', { name: 'Lien ordinaire' })).not.toHaveClass(/temporal-reference/)
      expect(await reading.getByRole('link').locator('.temporal-reference-icon').count()).toBe(0)

      // Les deux formes longues se replient sans élargir la page ni le panneau de note.
      for (const reference of [references.nth(2), references.nth(3)]) {
        const bounds = await reference.boundingBox()
        const content = await reading.boundingBox()
        expect(bounds!.width).toBeLessThanOrEqual(content!.width + 1)
        if (width === 375) expect(bounds!.height).toBeGreaterThan(30)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: info.outputPath('temporal-reading.png'), fullPage: true })

      // Le bouton natif garde son focus clavier et le refus reste hors de la pastille.
      const first = references.first()
      await first.focus()
      await first.press('Space')
      await expect(first).toBeFocused()
      expect(await first.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid')
      const message = first.locator('..').getByRole('status')
      await expect(message).toContainText('aucun lecteur disponible')
      await expect(first.getByRole('status')).toHaveCount(0)
      await references.last().click()
      await expect(reading.locator('.quote-callout').getByRole('status')).toContainText('aucun lecteur disponible')
      await page.getByRole('button', { name: 'Édition', exact: true }).click()
      expect(await original!.evaluate(element => element === document.querySelector('.cm-content'))).toBe(true)
      expect((await selection(editor)).doc).toBe(text)
      expect(writes).toEqual([])
    })
  }
}
