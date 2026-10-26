import { markdownToolbar, markdownToolbarEnabled } from './markdownToolbar'
import { captureMarker, setCaptureMarker, captureVisualTransaction } from './captureMarker'
import { useEffect, useLayoutEffect, useImperativeHandle, useRef } from 'react'
import type { TemporalReference } from './temporalReference'
import type { Ref } from 'react'
import { compactTemporalReferences } from './compactTemporalReferences'
import { markdownDecorations } from './markdownDecorations'
import { livePreviewHeadings } from './livePreviewHeadings'
import { tags } from '@lezer/highlight'
import { EditorState, StateEffect } from '@codemirror/state'
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, isolateHistory, redo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, HighlightStyle, syntaxHighlighting } from '@codemirror/language'

// Les couleurs suivent le CSS sans recréer l'état, l'historique ou la sélection.
// Les distinctions typographiques du Markdown sont conservées dans les deux modes.
const highlightStyle = HighlightStyle.define(defaultHighlightStyle.specs.map(style => ({
  ...style,
  // Les titres hors périmètre gardent le style source ; les lignes ATX admissibles
  // neutralisent seulement ce style hérité, sans écraser les liens et le code inline.
  ...(style.tag === tags.heading ? {
    fontWeight: 'var(--note-heading-syntax-weight, bold)',
    textDecoration: 'var(--note-heading-syntax-decoration, underline)',
  } : {}),
  ...(style.color ? { color: `light-dark(${style.color}, var(--syntax))` } : {}),
})))

const refreshImagePosition = StateEffect.define<null>()

/** Marque le point d'ajout sans texte temporaire ni transaction d'historique. */
class ImageInsertionCaret extends WidgetType {
  toDOM() {
    const element = document.createElement('span')
    element.className = 'image-insertion-caret'
    element.setAttribute('aria-hidden', 'true')
    element.title = 'Prochaine image insérée ici'
    element.textContent = '\u200b'
    return element
  }
}

interface Props {
  ref: Ref<MarkdownEditorHandle>
  initial: string
  active: boolean
  visible?: boolean
  imagesOpen?: boolean
  onChange: (content: string) => void
  onSave: () => void
  onNavigate: (reference: TemporalReference) => void
}

/** Action ponctuelle sur la session existante, sans remplacer son état. */
export interface MarkdownEditorHandle {
  /** Insère après la sélection sans effacer son texte, puis rend le focus au curseur. */
  insert(text: string): void
  /** Ajoute une référence connue au choix courant, sans remplacer la sélection ni voler le focus. */
  insertAsset(markdown: string, beforeInsert?: () => void): void
  /** Rend le focus au point courant après fermeture de la modale mobile. */
  focusInsertion(): void
  /** Réserve visuellement la position après sélection sans modifier la note. */
  beginCapture(id: string, label: string): void
  /** Insère une seule fois si l'intention existe toujours dans cette session. */
  finishCapture(id: string, markdown: string): boolean
  /** Retire une intention refusée sans toucher au document. */
  abandonCapture(id: string): void
  /** Vérifie l’emplacement, révèle éventuellement la vue, puis insère un bloc isolé dans Undo. */
  insertCitation(markdown: string, beforeInsert?: () => void): void
}

/** Garde l'état CodeMirror stable ; seules les actions utilisateur modifient le texte. */
export function MarkdownEditor({
  initial,
  active,
  visible = true,
  imagesOpen = false,
  onChange,
  onSave,
  onNavigate,
  ref,
}: Props) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const wasActive = useRef(active)
  const explicitPosition = useRef(false)
  const showImagePosition = useRef(false)
  showImagePosition.current = imagesOpen && active
  const callbacks = useRef({ onChange, onSave, onNavigate })
  callbacks.current = { onChange, onSave, onNavigate }
  /** Ajoute uniquement du texte ; les séparateurs de bloc font partie du même Undo. */
  function insert(text: string, citation = false, beforeInsert?: () => void) {
    const view = editor.current
    if (!view || !active) throw new Error('Passez en mode Édition pour insérer une référence.')
    if (citation && view.state.doc.length && !explicitPosition.current) {
      throw new Error('Placez le curseur dans la note, puis recommencez la sélection de transcription.')
    }
    // Le refus précède toute révélation ; la vue visible reçoit ensuite la même transaction.
    beforeInsert?.()
    const position = view.state.selection.main.to
    let existingBreaks = 0
    if (citation) {
      const before = view.state.sliceDoc(0, position)
      const after = view.state.sliceDoc(position)
      const preceding = before.match(/\n*$/)![0].length
      existingBreaks = Math.min(2, after.match(/^\n*/)![0].length)
      const prefix = position ? '\n'.repeat(Math.max(0, 2 - preceding)) : ''
      text = prefix + text + '\n'.repeat(2 - existingBreaks)
    }
    view.dispatch({
      changes: { from: position, insert: text },
      selection: { anchor: position + text.length + existingBreaks },
      annotations: isolateHistory.of('full'),
      scrollIntoView: true,
    })
    view.focus()
  }
  useImperativeHandle(ref, () => ({
    insert: text => insert(text),
    insertAsset(markdown, beforeInsert) {
      const view = editor.current
      if (!view || !active) throw new Error('Passez en Édition pour insérer une image.')
      if (view.state.doc.length && !explicitPosition.current) {
        throw new Error('Placez explicitement le curseur dans la note avant d’insérer une image.')
      }
      beforeInsert?.()
      const position = view.state.selection.main.to
      explicitPosition.current = true
      view.dispatch({
        changes: { from: position, insert: markdown },
        selection: { anchor: position + markdown.length },
        annotations: isolateHistory.of('full'),
        scrollIntoView: true,
      })
    },
    focusInsertion() { editor.current?.focus() },
    beginCapture(id, label) {
      const view = editor.current
      if (!view || !active) throw new Error('Passez en Édition pour capturer une image.')
      const position = view.state.selection.main.to
      view.dispatch({
        effects: setCaptureMarker.of({ id, position, label }),
        selection: { anchor: position },
        annotations: [captureVisualTransaction, isolateHistory.of('full')],
      })
      view.focus()
    },
    finishCapture(id, markdown) {
      const view = editor.current
      const marker = view?.state.field(captureMarker)
      if (!view || !marker || marker.id !== id) return false
      const selection = view.state.selection
      const atMarker = selection.ranges.length === 1 && selection.main.empty &&
        selection.main.head === marker.position
      view.dispatch({
        changes: { from: marker.position, insert: markdown },
        // Accompagner l'insertion seulement si le curseur attend encore au marqueur.
        selection: atMarker ? { anchor: marker.position + markdown.length } : undefined,
        effects: setCaptureMarker.of(null),
        annotations: isolateHistory.of('full'),
      })
      return true
    },
    abandonCapture(id) {
      const view = editor.current
      if (view?.state.field(captureMarker)?.id === id) {
        view.dispatch({ effects: setCaptureMarker.of(null), annotations: captureVisualTransaction })
      }
    },
    insertCitation: (markdown, beforeInsert) => insert(markdown, true, beforeInsert),
  }))
  useEffect(() => {
    explicitPosition.current = false
    /** La décoration suit toujours la sélection actuelle, même lorsque la galerie détient le focus. */
    function imagePosition(view: EditorView) {
      if (!showImagePosition.current || (view.state.doc.length && !explicitPosition.current)) return Decoration.none
      const { from, to } = view.state.selection.main
      const ranges = []
      if (from !== to) ranges.push(Decoration.mark({ class: 'image-insertion-selection' }).range(from, to))
      ranges.push(Decoration.widget({ widget: new ImageInsertionCaret(), side: 1 }).range(to))
      return Decoration.set(ranges, true)
    }
    const positionPlugin = ViewPlugin.fromClass(class {
      decorations
      constructor(view: EditorView) { this.decorations = imagePosition(view) }
      update(update: ViewUpdate) {
        if (update.view.hasFocus && update.transactions.some(transaction =>
          ['select', 'input', 'delete', 'undo', 'redo'].some(event => transaction.isUserEvent(event)))) {
          explicitPosition.current = true
        }
        this.decorations = imagePosition(update.view)
      }
    }, { decorations: plugin => plugin.decorations })
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          // Le découpage natif accepte CRLF, CR et LF ; la sérialisation produit du LF.
          history(), captureMarker, positionPlugin, markdown(), markdownToolbar(), syntaxHighlighting(highlightStyle),
          EditorView.lineWrapping, markdownDecorations, livePreviewHeadings,
          compactTemporalReferences(reference => callbacks.current.onNavigate(reference)),
          EditorView.contentAttributes.of({ 'aria-label': 'Note Markdown' }),
          keymap.of([
            { key: 'Mod-s', run: () => { callbacks.current.onSave(); return true } },
            // CodeMirror ne fournit Ctrl+Shift+Z que sous Linux par défaut.
            { key: 'Ctrl-Shift-z', run: redo, preventDefault: true },
            ...defaultKeymap, ...historyKeymap,
          ]),
          EditorView.domEventHandlers({
            pointerdown(event, view) {
              if (event.button === 0 && event.target instanceof Element && event.target.closest('.cm-content')) {
                explicitPosition.current = true
                view.dispatch({ effects: refreshImagePosition.of(null), annotations: captureVisualTransaction })
              }
            },
            keydown(event, view) {
              if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
                explicitPosition.current = true
                view.dispatch({ effects: refreshImagePosition.of(null), annotations: captureVisualTransaction })
              }
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.sliceDoc())
          }),
        ],
      }),
    })
    editor.current = view
    view.dispatch({ effects: markdownToolbarEnabled.of(active && visible) })
    return () => { view.destroy(); editor.current = null }
    // Le parent remonte cet éditeur uniquement pour une nouvelle version choisie explicitement.
  }, [initial])
  useEffect(() => {
    if (active && !wasActive.current) {
      editor.current?.requestMeasure()
      editor.current?.focus()
    }
    wasActive.current = active
  }, [active])
  useLayoutEffect(() => {
    editor.current?.dispatch({ effects: refreshImagePosition.of(null), annotations: captureVisualTransaction })
  }, [imagesOpen, active, initial])
  useLayoutEffect(() => {
    editor.current?.dispatch({ effects: markdownToolbarEnabled.of(active && visible) })
  }, [active, visible, initial])
  useLayoutEffect(() => {
    // Réafficher un onglet ne reprend pas le focus détenu par son bouton.
    if (visible) editor.current?.requestMeasure()
  }, [visible])
  return <div className="markdown-editor" ref={host} />
}
