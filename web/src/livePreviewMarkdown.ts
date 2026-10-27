import { syntaxTree } from '@codemirror/language'
import { StateEffect } from '@codemirror/state'
import type { EditorState } from '@codemirror/state'
import { ViewPlugin } from '@codemirror/view'
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view'
import { headingDecorations } from './livePreviewHeadings'

const refreshPreview = StateEffect.define<null>()

/** Calcule la présentation ciblée sans créer une seconde vue du document. */
function previewDecorations(state: EditorState, visibleRanges: readonly { from: number; to: number }[]) {
  return headingDecorations(state, visibleRanges)
}

/** Suspend la géométrie des titres pendant les gestes natifs ; mappe les plages conservées. */
export const livePreviewMarkdown = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  dragging = false
  composing = false
  clickCount = 0
  clickPresentation: { doc: EditorState['doc']; decorations: DecorationSet } | null = null
  timer: ReturnType<typeof setTimeout> | undefined
  editContext: EventTarget | null = null
  destroyed = false

  constructor(readonly view: EditorView) {
    this.decorations = previewDecorations(view.state, view.visibleRanges)
    window.addEventListener('mouseup', this.endDrag)
    window.addEventListener('pointercancel', this.endDrag)
    window.addEventListener('blur', this.endDrag)
    // CodeMirror attache l'EditContext après la construction des plugins.
    queueMicrotask(() => { if (!this.destroyed) this.observeEditContext() })
  }

  /** Écoute aussi la composition hors DOM, sans remplacer ni désactiver l'EditContext natif. */
  observeEditContext() {
    const context = (this.view.contentDOM as HTMLElement & { editContext?: EventTarget | null }).editContext ?? null
    if (context === this.editContext) return
    this.editContext?.removeEventListener('compositionstart', this.startComposition)
    this.editContext?.removeEventListener('compositionend', this.endComposition)
    this.editContext = context
    context?.addEventListener('compositionstart', this.startComposition)
    context?.addEventListener('compositionend', this.endComposition)
  }

  startComposition = () => {
    clearTimeout(this.timer)
    this.clickPresentation = null
    this.composing = true
  }

  endComposition = () => {
    this.composing = false
    this.scheduleRefresh()
  }

  /** Attend la sélection finale et les dernières mutations natives avant la présentation. */
  scheduleRefresh() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.view.dispatch({ effects: refreshPreview.of(null) }), 0)
  }

  endDrag = () => {
    if (!this.dragging) return
    this.dragging = false
    // Un glisser du premier appui n'est pas le début d'un double clic sur un mot.
    if (this.clickCount === 1 && !this.view.state.selection.main.empty) this.clickPresentation = null
    this.scheduleRefresh()
  }

  update(update: ViewUpdate) {
    this.observeEditContext()
    if (update.docChanged || update.transactions.some(transaction =>
      transaction.selection && !transaction.isUserEvent('select.pointer'))) this.clickPresentation = null
    if (this.dragging || this.composing || update.view.compositionStarted) {
      // Une capture ou une saisie peut déplacer les décorations même pendant le gel.
      this.decorations = this.decorations.map(update.changes)
      return
    }
    if (update.docChanged || update.selectionSet || update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refreshPreview)))) {
      this.decorations = previewDecorations(update.state, update.view.visibleRanges)
    }
  }

  destroy() {
    this.destroyed = true
    clearTimeout(this.timer)
    this.editContext?.removeEventListener('compositionstart', this.startComposition)
    this.editContext?.removeEventListener('compositionend', this.endComposition)
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
        view.dispatch({ effects: refreshPreview.of(null) })
      } else {
        const heading = event.target instanceof Element ? event.target.closest('.cm-note-heading') : null
        this.clickPresentation = plain && event.detail === 1 && heading && !heading.querySelector('.cm-note-heading-marker')
          ? { doc: view.state.doc, decorations: this.decorations }
          : null
      }
    },
    compositionstart() { this.startComposition() },
    compositionend() { this.endComposition() },
  },
})
