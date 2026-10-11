import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'

interface Props {
  initial: string
  onChange: (content: string) => void
  onSave: () => void
}

/** Garde l'état CodeMirror stable ; seules les actions utilisateur modifient le texte. */
export function MarkdownEditor({ initial, onChange, onSave }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onChange, onSave })
  callbacks.current = { onChange, onSave }
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          // LF est le seul séparateur structurel : CR reste dans le texte.
          // Ainsi CRLF et les mélanges traversent édition et historique sans normalisation.
          EditorState.lineSeparator.of('\n'),
          history(), markdown(), syntaxHighlighting(defaultHighlightStyle),
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
    return () => view.destroy()
    // Le parent remonte cet éditeur uniquement pour une nouvelle version choisie explicitement.
  }, [initial])
  return <div className="markdown-editor" ref={host} />
}
