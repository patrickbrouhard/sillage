import { EditorView } from '@codemirror/view'

/** Retrouve la vue réelle de l'application par l'API publique, sans dépendre des lignes rendues. */
function editorView() {
  const element = document.querySelector<HTMLElement>('.cm-editor')
  const view = element && EditorView.findFromDOM(element)
  if (!view) throw new Error('Éditeur indisponible')
  return view
}

/** Lit les positions et le texte documentaires, y compris sous des remplacements ou hors viewport. */
export function snapshot() {
  const view = editorView()
  const main = view.state.selection.main
  return {
    doc: view.state.sliceDoc(),
    anchor: main.anchor,
    head: main.head,
    text: view.state.sliceDoc(main.from, main.to),
    compositionStarted: view.compositionStarted,
    editContext: Boolean((view.contentDOM as HTMLElement & { editContext?: EventTarget }).editContext),
  }
}

/** Prépare une sélection exacte dans la session existante pour les scénarios d'entrée native. */
export function select(anchor: number, head = anchor) {
  editorView().dispatch({ selection: { anchor, head } })
}

declare global {
  interface Window {
    editorProbe: { snapshot: typeof snapshot; select: typeof select }
  }
}
