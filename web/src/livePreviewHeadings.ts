import { syntaxTree } from '@codemirror/language'
import { StateEffect } from '@codemirror/state'
import type { EditorState, Range } from '@codemirror/state'
import { Decoration, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view'

const refreshHeadings = StateEffect.define<null>()

/** Décore les titres ATX racine analysés dans les plages visibles, sans modifier leur source. */
export function headingDecorations(
  state: EditorState,
  visibleRanges: readonly { from: number; to: number }[],
): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const seen = new Set<number>()
  for (const visible of visibleRanges) {
    syntaxTree(state).iterate({
      from: visible.from,
      to: visible.to,
      enter(cursor) {
        if (!/^ATXHeading[1-6]$/.test(cursor.name) || cursor.node.parent?.name !== 'Document') return
        const line = state.doc.lineAt(cursor.from)
        if (seen.has(line.from)) return false
        seen.add(line.from)
        const level = cursor.name.slice(-1)
        ranges.push(Decoration.line({ class: 'cm-note-heading cm-note-h' + level }).range(line.from))

        // L'arbre décide de l'admissibilité et de la clôture. Les blancs adjacents
        // sont absorbés sans jamais inclure le saut de ligne ni les # du contenu.
        const opening = cursor.node.firstChild!
        const closing = cursor.node.lastChild!
        const prefixEnd = opening.to + state.sliceDoc(opening.to, line.to).match(/^[ \t]*/)![0].length
        const suffixStart = closing.from > opening.from && closing.name === 'HeaderMark'
          ? closing.from - state.sliceDoc(prefixEnd, closing.from).match(/[ \t]*$/)![0].length
          : line.to
        // La borne haute exclusive écarte une sélection finissant au début de cette ligne.
        const selected = state.selection.ranges.some(range => range.empty
          ? range.head >= line.from && range.head <= line.to
          : range.from <= line.to && range.to > line.from)
        // Un titre sans contenu utile reste compréhensible et directement éditable.
        const compact = !selected && state.sliceDoc(prefixEnd, suffixStart).trim().length > 0
        const marker = compact ? Decoration.replace({}) : Decoration.mark({ class: 'cm-note-heading-marker' })
        ranges.push(marker.range(line.from, prefixEnd))
        if (suffixStart < line.to) ranges.push(marker.range(suffixStart, line.to))
        return false
      },
    })
  }
  return Decoration.set(ranges, true)
}

/** Suspend la géométrie des titres pendant les gestes natifs ; mappe les plages conservées. */
export const livePreviewHeadings = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  dragging = false
  composing = false
  clickCount = 0
  clickPresentation: { doc: EditorState['doc']; decorations: DecorationSet } | null = null
  timer: ReturnType<typeof setTimeout> | undefined

  constructor(readonly view: EditorView) {
    this.decorations = headingDecorations(view.state, view.visibleRanges)
    window.addEventListener('mouseup', this.endDrag)
    window.addEventListener('pointercancel', this.endDrag)
    window.addEventListener('blur', this.endDrag)
  }

  /** Attend la sélection finale et les dernières mutations natives avant la présentation. */
  scheduleRefresh() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.view.dispatch({ effects: refreshHeadings.of(null) }), 0)
  }

  endDrag = () => {
    if (!this.dragging) return
    this.dragging = false
    // Un glisser du premier appui n'est pas le début d'un double clic sur un mot.
    if (this.clickCount === 1 && !this.view.state.selection.main.empty) this.clickPresentation = null
    this.scheduleRefresh()
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.transactions.some(transaction =>
      transaction.selection && !transaction.isUserEvent('select.pointer'))) this.clickPresentation = null
    if (this.dragging || this.composing || update.view.compositionStarted) {
      // Une capture ou une saisie peut déplacer les décorations même pendant le gel.
      this.decorations = this.decorations.map(update.changes)
      return
    }
    if (update.docChanged || update.selectionSet || update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refreshHeadings)))) {
      this.decorations = headingDecorations(update.state, update.view.visibleRanges)
    }
  }

  destroy() {
    clearTimeout(this.timer)
    window.removeEventListener('mouseup', this.endDrag)
    window.removeEventListener('pointercancel', this.endDrag)
    window.removeEventListener('blur', this.endDrag)
  }
}, {
  decorations: plugin => plugin.decorations,
  eventHandlers: {
    mousedown(event, view) {
      if (event.button !== 0 || this.composing || view.compositionStarted) return
      clearTimeout(this.timer)
      this.dragging = true
      this.clickCount = event.detail
      const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
      if (plain && event.detail > 1 && this.clickPresentation?.doc === view.state.doc) {
        // Le navigateur identifie les appuis successifs. Rétablir leur présentation
        // initiale avant la sélection native conserve la cible compacte, sans délai
        // du clic simple ni second calcul de position après révélation.
        this.decorations = this.clickPresentation.decorations
        view.dispatch({ effects: refreshHeadings.of(null) })
      } else {
        const heading = event.target instanceof Element ? event.target.closest('.cm-note-heading') : null
        this.clickPresentation = plain && event.detail === 1 && heading && !heading.querySelector('.cm-note-heading-marker')
          ? { doc: view.state.doc, decorations: this.decorations }
          : null
      }
    },
    compositionstart() {
      clearTimeout(this.timer)
      this.composing = true
    },
    compositionend() {
      this.composing = false
      this.scheduleRefresh()
    },
  },
})
