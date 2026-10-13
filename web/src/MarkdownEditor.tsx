import { useEffect, useImperativeHandle, useRef } from 'react'
import type { Ref } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands'
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
}

/** Action ponctuelle sur la session existante, sans remplacer son état. */
export interface MarkdownEditorHandle {
  /** Insère après la sélection sans effacer son texte, puis rend le focus au curseur. */
  insert(text: string): void
}

/** Garde l'état CodeMirror stable ; seules les actions utilisateur modifient le texte. */
export function MarkdownEditor({ initial, active, onChange, onSave, ref }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const wasActive = useRef(active)
  const callbacks = useRef({ onChange, onSave })
  callbacks.current = { onChange, onSave }
  useImperativeHandle(ref, () => ({
    insert(text) {
      const view = editor.current
      if (!view || !active) throw new Error('Passez en mode Édition pour insérer une référence.')
      // La borne supérieure reste la même quel que soit le sens de la sélection.
      const position = view.state.selection.main.to
      view.dispatch({
        changes: { from: position, insert: text },
        selection: { anchor: position + text.length },
        annotations: isolateHistory.of('full'),
        scrollIntoView: true,
      })
      view.focus()
    },
  }))
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          // LF est le seul séparateur structurel : CR reste dans le texte.
          // Ainsi CRLF et les mélanges traversent édition et historique sans normalisation.
          EditorState.lineSeparator.of('\n'),
          history(), markdown(), syntaxHighlighting(highlightStyle),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': 'Note Markdown' }),
          keymap.of([
            { key: 'Mod-s', run: () => { callbacks.current.onSave(); return true } },
            ...defaultKeymap, ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
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
