import { captureMarker, setCaptureMarker, captureVisualTransaction } from './captureMarker'
import { useEffect, useImperativeHandle, useRef } from 'react'
import type { TemporalReference } from './temporalReference'
import type { Ref } from 'react'
import { compactTemporalReferences } from './compactTemporalReferences'
import { markdownDecorations } from './markdownDecorations'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, isolateHistory, redo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, HighlightStyle, syntaxHighlighting } from '@codemirror/language'

// Les couleurs suivent le CSS sans recréer l'état, l'historique ou la sélection.
// Les distinctions typographiques du Markdown sont conservées dans les deux modes.
const highlightStyle = HighlightStyle.define(defaultHighlightStyle.specs.map(style => ({
  ...style,
  ...(style.color ? { color: `light-dark(${style.color}, var(--syntax))` } : {}),
})))

interface Props {
  ref: Ref<MarkdownEditorHandle>
  initial: string
  active: boolean
  onChange: (content: string) => void
  onSave: () => void
  onNavigate: (reference: TemporalReference) => void
}

/** Action ponctuelle sur la session existante, sans remplacer son état. */
export interface MarkdownEditorHandle {
  /** Insère après la sélection sans effacer son texte, puis rend le focus au curseur. */
  insert(text: string): void
  /** Réserve visuellement la position après sélection sans modifier la note. */
  beginCapture(id: string, label: string): void
  /** Insère une seule fois si l'intention existe toujours dans cette session. */
  finishCapture(id: string, markdown: string): boolean
  /** Retire une intention refusée sans toucher au document. */
  abandonCapture(id: string): void
  /** Insère un bloc uniquement à un emplacement choisi, sauf pour un document vide. */
  insertCitation(markdown: string): void
}

/** Garde l'état CodeMirror stable ; seules les actions utilisateur modifient le texte. */
export function MarkdownEditor({ initial, active, onChange, onSave, onNavigate, ref }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const wasActive = useRef(active)
  const explicitPosition = useRef(false)
  const callbacks = useRef({ onChange, onSave, onNavigate })
  callbacks.current = { onChange, onSave, onNavigate }
  /** Ajoute uniquement du texte ; les séparateurs de bloc font partie du même Undo. */
  function insert(text: string, citation = false) {
    const view = editor.current
    if (!view || !active) throw new Error('Passez en mode Édition pour insérer une référence.')
    if (citation && view.state.doc.length && !explicitPosition.current) {
      throw new Error('Placez le curseur dans la note, puis recommencez la sélection de transcription.')
    }
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
    insertCitation: markdown => insert(markdown, true),
  }))
  useEffect(() => {
    explicitPosition.current = false
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          // Le découpage natif accepte CRLF, CR et LF ; la sérialisation produit du LF.
          history(), captureMarker, markdown(), syntaxHighlighting(highlightStyle),
          EditorView.lineWrapping, markdownDecorations,
          compactTemporalReferences(reference => callbacks.current.onNavigate(reference)),
          EditorView.contentAttributes.of({ 'aria-label': 'Note Markdown' }),
          keymap.of([
            { key: 'Mod-s', run: () => { callbacks.current.onSave(); return true } },
            // CodeMirror ne fournit Ctrl+Shift+Z que sous Linux par défaut.
            { key: 'Ctrl-Shift-z', run: redo, preventDefault: true },
            ...defaultKeymap, ...historyKeymap,
          ]),
          EditorView.domEventHandlers({
            pointerdown(event) {
              if (event.button === 0 && event.target instanceof Element && event.target.closest('.cm-content')) {
                explicitPosition.current = true
              }
            },
            keydown(event) {
              if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
                explicitPosition.current = true
              }
            },
          }),
          EditorView.updateListener.of((update) => {
            // Une saisie ou sélection utilisateur compte ; focus et insertion programmatiques non.
            if (update.view.hasFocus && update.transactions.some(transaction =>
              ['select', 'input', 'delete', 'undo', 'redo'].some(event => transaction.isUserEvent(event)))) {
              explicitPosition.current = true
            }
            if (update.docChanged) callbacks.current.onChange(update.state.sliceDoc())
          }),
        ],
      }),
    })
    editor.current = view
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
  return <div className="markdown-editor" ref={host} />
}
