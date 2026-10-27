import { EditorSelection } from '@codemirror/state'
import type { EditorState, TransactionSpec } from '@codemirror/state'
import { isolateHistory } from '@codemirror/commands'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { defaultUrlTransform } from 'react-markdown'

/** Commandes locales disponibles dans la barre contextuelle. */
export type MarkdownAction = 'bold' | 'italic' | 'code' | 'link' | 0 | 1 | 2 | 3 | 4 | 5 | 6

interface Node {
  type: string
  position?: { start: { offset?: number }; end: { offset?: number } }
  children?: Node[]
  url?: string
  depth?: number
}
interface Edit { from: number; to: number; insert: string }

/** Un refus explicite ne produit jamais de transaction de document. */
export type MarkdownResult = { reason: string } | { transaction: TransactionSpec }

// GFM détecte les tableaux absents de la grammaire CodeMirror. Ces dépendances
// servent déjà en Lecture ; l'arbre valide, mais ne sérialise jamais la note.
const parser = unified().use(remarkParse).use(remarkGfm)
const parsedDocuments = new WeakMap<EditorState['doc'], Node>()

/** Réutilise l'analyse du même document lors des interactions visuelles. */
function parsedDocument(state: EditorState): Node {
  let root = parsedDocuments.get(state.doc)
  if (!root) {
    root = parser.parse(state.sliceDoc()) as Node
    parsedDocuments.set(state.doc, root)
  }
  return root
}
const start = (node: Node) => node.position?.start.offset ?? 0
const end = (node: Node) => node.position?.end.offset ?? 0
const overlaps = (node: Node, from: number, to: number) => start(node) < to && end(node) > from

/** Aplatit l'arbre en conservant les positions dans le Markdown source. */
function nodes(root: Node): Node[] {
  return [root, ...(root.children ?? []).flatMap(nodes)]
}

/** Compare les structures de bloc sans dépendre de leurs nouvelles positions. */
function blockShape(node: Node): string {
  const blocks = [
    'root', 'paragraph', 'heading', 'blockquote', 'list', 'listItem',
    'code', 'html', 'definition', 'table', 'thematicBreak',
  ]
  if (!blocks.includes(node.type)) return ''
  return node.type + (node.depth ?? '') + '(' + (node.children ?? []).map(blockShape).join('') + ')'
}

/** Vérifie qu'une modification inline ne révèle ni ne détruit une structure de bloc. */
function inlineResult(
  state: EditorState,
  root: Node,
  edits: Edit[],
  from: number,
  to: number,
): MarkdownResult {
  const next = state.changes(edits).apply(state.doc).toString()
  if (blockShape(root) !== blockShape(parser.parse(next) as Node)) {
    return { reason: 'Cette sélection touche la structure du bloc Markdown.' }
  }
  return result(state, edits, from, to)
}

/** Conserve le sens d'une sélection inversée après une modification locale. */
function result(state: EditorState, edits: Edit[], from: number, to: number): MarkdownResult {
  const reversed = state.selection.main.anchor > state.selection.main.head
  return { transaction: {
    changes: edits,
    selection: EditorSelection.single(reversed ? to : from, reversed ? from : to),
    annotations: isolateHistory.of('full'),
    userEvent: 'input.markdown',
  } }
}

/** Exclut une dernière ligne dont seul le début appartient à la sélection. */
function selectedLines(state: EditorState) {
  const { from, to } = state.selection.main
  const first = state.doc.lineAt(from).number
  const lastLine = state.doc.lineAt(to)
  const last = lastLine.number - (lastLine.from === to && to > from ? 1 : 0)
  return Array.from({ length: last - first + 1 }, (_, index) => state.doc.line(first + index))
}

/** Reconnaît uniquement les titres ATX de premier niveau de structure. */
function atx(text: string) {
  return /^( {0,3})(#{1,6})(?:[ \t]+(.*)|$)/.exec(text)
}

/** Les positions Remark commencent après l'indentation admissible de trois espaces. */
function lineBlock(root: Node, line: { from: number; to: number; text: string }) {
  const contentStart = line.from + line.text.match(/^ {0,3}/)![0].length
  return root.children?.find(node => start(node) <= contentStart && end(node) >= line.to)
}

/** Indique un état homogène fiable, sans attribuer un style uniforme à un mélange. */
export function markdownBlockLabel(state: EditorState): string {
  const root = parsedDocument(state)
  const levels = new Set(selectedLines(state).filter(line => line.text.trim()).map(line => {
    const block = lineBlock(root, line)
    if (block?.type === 'heading' && atx(line.text)) return 'H' + block.depth
    return block?.type === 'paragraph' ? 'Texte' : 'Mixte'
  }))
  return levels.size === 1 ? [...levels][0] : 'Mixte'
}

/** Affecte un niveau aux lignes entières ; une incompatibilité annule toute la commande. */
function heading(state: EditorState, level: number, root: Node): MarkdownResult {
  const edits: Edit[] = []
  const localEdits: Edit[] = []
  for (const line of selectedLines(state)) {
    const block = lineBlock(root, line)
    if (block && !['paragraph', 'heading'].includes(block.type)) {
      return { reason: 'Cette sélection contient une liste, citation, table, définition, du code ou du HTML.' }
    }
    if (!line.text.trim()) continue
    const match = atx(line.text)
    if (block?.type === 'heading' && !match) return { reason: 'Les titres Setext ne sont pas transformés.' }
    if (!block) return { reason: 'La structure de cette ligne ne permet pas une transformation fiable.' }
    if (match && match[2].length === level) continue
    if (!match && level === 0) continue
    // La clôture ATX n'appartient pas au contenu. Les autres marques restent intactes.
    const body = match ? (match[3] ?? '').replace(/(?:[ \t]+|^)#+[ \t]*$/, '') : line.text.replace(/^ {0,3}/, '')
    const indent = match?.[1] ?? line.text.match(/^ {0,3}/)![0]
    edits.push({ from: line.from, to: line.to, insert: indent + (level ? '#'.repeat(level) + ' ' : '') + body })
    // Préserver les caractères du contenu maintient aussi les marqueurs de capture
    // à l'intérieur de la ligne. Seuls le préfixe et la clôture sont réellement modifiés.
    const prefixEnd = match
      ? indent.length + match[2].length + line.text.slice(indent.length + match[2].length).match(/^[ \t]*/)![0].length
      : indent.length
    localEdits.push({
      from: line.from + indent.length,
      to: line.from + prefixEnd,
      insert: level ? '#'.repeat(level) + ' ' : '',
    })
    if (match && prefixEnd + body.length < line.text.length) {
      localEdits.push({ from: line.from + prefixEnd + body.length, to: line.to, insert: '' })
    }
  }
  const changes = state.changes(edits)
  const updated = parser.parse(changes.apply(state.doc).toString()) as Node
  // Retirer « # » peut révéler liste, HTML, définition ou Setext. Le contexte complet
  // permet de refuser aussi une interprétation induite par les lignes voisines.
  for (const edit of edits) {
    const from = changes.mapPos(edit.from, -1)
    const to = from + edit.insert.length
    const block = lineBlock(updated, { from, to, text: edit.insert })
    if (edit.insert.trim() && (level
      ? block?.type !== 'heading' || block.depth !== level || start(block) < from
      : block?.type !== 'paragraph')) {
      return { reason: 'Cette transformation révélerait une autre structure Markdown. La sélection est conservée.' }
    }
  }
  // Les positions internes aux lignes remplacées suivent leur contenu utile.
  const map = (position: number) => {
    let delta = 0
    for (const edit of edits) {
      if (position >= edit.from && position <= edit.to) {
        const previous = state.sliceDoc(edit.from, edit.to)
        const oldPrefix = previous.match(/^ {0,3}#{1,6}(?:[ \t]+|$)/)?.[0].length ??
          previous.match(/^ {0,3}/)![0].length
        const newPrefix = edit.insert.match(/^ {0,3}#{1,6}(?:[ \t]+|$)/)?.[0].length ??
          edit.insert.match(/^ {0,3}/)![0].length
        return edit.from + delta + Math.min(edit.insert.length, Math.max(newPrefix, position - edit.from - oldPrefix + newPrefix))
      }
      if (position > edit.to) delta += edit.insert.length - (edit.to - edit.from)
    }
    return position + delta
  }
  return result(state, localEdits, map(state.selection.main.from), map(state.selection.main.to))
}

/** Trouve le contenu d'une enveloppe reconnue par l'analyseur. */
function envelope(node: Node, source: string): { from: number; to: number } | null {
  const from = start(node), to = end(node)
  if (node.type === 'strong' || node.type === 'emphasis') {
    const width = node.type === 'strong' ? 2 : 1
    return { from: from + width, to: to - width }
  }
  if (node.type !== 'inlineCode') return null
  const width = source.slice(from, to).match(/^`+/)![0].length
  let innerFrom = from + width, innerTo = to - width
  const literal = source.slice(innerFrom, innerTo)
  if (literal.startsWith(' ') && literal.endsWith(' ') && /[^ ]/.test(literal)) {
    innerFrom++; innerTo--
  }
  return { from: innerFrom, to: innerTo }
}

/** Filtre comme en Lecture ; les références temporelles ont leurs actions dédiées. */
export function markdownLinkDestination(value: string): { destination: string } | { reason: string } {
  const destination = value.trim()
  if (!destination || /[\u0000-\u001f\u007f]/.test(destination) ||
      !defaultUrlTransform(destination) || /^sillage:/i.test(destination)) {
    return { reason: 'Adresse non admissible. Utilisez un lien Web, relatif, une ancre ou un protocole accepté en Lecture.' }
  }
  return { destination }
}

/** Prépare une modification atomique depuis la sélection CodeMirror, sans effet externe. */
export function transformMarkdown(state: EditorState, action: MarkdownAction, address?: string): MarkdownResult {
  if (state.selection.ranges.length !== 1 || state.selection.main.empty) {
    return { reason: 'Sélectionnez une seule plage de texte.' }
  }
  const source = state.sliceDoc()
  const root = parsedDocument(state)
  if (typeof action === 'number') return heading(state, action, root)
  const selection = state.selection.main
  if (state.doc.lineAt(selection.from).number !== state.doc.lineAt(selection.to).number) {
    return { reason: 'Cette commande demande une sélection sur une seule ligne de source.' }
  }
  const selected = source.slice(selection.from, selection.to)
  const from = selection.from + selected.match(/^[ \t]*/)![0].length
  const to = selection.to - selected.match(/[ \t]*$/)![0].length
  if (from >= to) return { reason: 'La sélection ne contient pas de texte utile.' }
  const all = nodes(root)
  const touching = all.filter(node => overlaps(node, from, to))
  if (touching.some(node => ['code', 'html', 'definition', 'table', 'image', 'imageReference', 'linkReference'].includes(node.type))) {
    return { reason: 'Cette sélection touche une structure protégée (code, HTML, table, image ou référence).' }
  }
  if (touching.some(node => node.type === 'link' && /^sillage:/i.test(node.url ?? ''))) {
    return { reason: 'Les références temporelles, leurs libellés et destinations sont protégés.' }
  }
  if (/^ {0,3}(?:> ?)+\[!/.test(state.doc.lineAt(from).text)) {
    return { reason: 'Les en-têtes de callout restent littéraux.' }
  }
  const type = { bold: 'strong', italic: 'emphasis', code: 'inlineCode', link: 'link' }[action]
  const exact = touching.find(node => {
    const inner = envelope(node, source)
    return node.type === type && ((start(node) === from && end(node) === to) || (inner?.from === from && inner.to === to))
  })
  if (exact && action !== 'link') {
    const inner = envelope(exact, source)!
    const text = source.slice(inner.from, inner.to)
    if (!text.trim()) return { reason: 'La sélection ne contient pas de texte utile.' }
    return inlineResult(state, root, [
      { from: start(exact), to: inner.from, insert: '' },
      { from: inner.to, to: end(exact), insert: '' },
    ], start(exact), start(exact) + text.length)
  }
  // Accepter les compositions complètes, mais pas les styles partiels à uniformiser.
  for (const node of touching) {
    if (['strong', 'emphasis', 'delete', 'inlineCode', 'link'].includes(node.type)) {
      const contained = start(node) >= from && end(node) <= to
      const inner = envelope(node, source)
      const inside = inner && from >= inner.from && to <= inner.to
      if ((node.type === type && !(action === 'code' && contained)) ||
          (node.type === 'inlineCode' && !(action === 'code' && contained)) || (!contained && !inside) ||
          (node.type === 'link' && (action === 'link' || !contained))) {
        return { reason: 'La sélection traverse une mise en forme ou un lien existant de façon ambiguë.' }
      }
    }
  }
  const text = source.slice(from, to)
  let prefix: string, suffix: string
  if (action === 'link') {
    if (address === undefined) return result(state, [], from, to)
    const validated = markdownLinkDestination(address)
    if ('reason' in validated) return validated
    // Les chevrons protègent les parenthèses ; l'encodage protège chevrons et espaces.
    const url = validated.destination.replace(/[<>"\\ ]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())
    const label = text.replace(/[\\`*_[\]<>!~&]/g, '\\$&')
    const destination = url.replace(/&/g, '&amp;')
    const insert = '[' + label + '](<' + destination + '>)'
    const next = source.slice(0, from) + insert + source.slice(to)
    const link = nodes(parser.parse(next) as Node).find(node =>
      node.type === 'link' && start(node) === from &&
      end(node) === from + insert.length && node.url === url)
    if (!link) return { reason: 'Le libellé ne permet pas de créer un lien fiable dans ce contexte.' }
    // Insérer les échappements à leur place conserve les positions du texte existant.
    const insertions = new Map<number, string>([[from, '['], [to, '](<' + destination + '>)']])
    for (let index = 0; index < text.length; index++) {
      if (/[\\`*_[\]<>!~&]/.test(text[index])) {
        const position = from + index
        insertions.set(position, (insertions.get(position) ?? '') + '\\')
      }
    }
    const edits = [...insertions].sort(([left], [right]) => left - right)
      .map(([position, value]) => ({ from: position, to: position, insert: value }))
    return inlineResult(state, root, edits, from + 1, from + 1 + label.length)
  }
  if (action === 'code') {
    const runs = text.match(/`+/g) ?? []
    const delimiter = '`'.repeat(Math.max(0, ...runs.map(run => run.length)) + 1)
    const padding = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
    prefix = delimiter + padding; suffix = padding + delimiter
  } else {
    prefix = suffix = action === 'bold' ? '**' : '*'
  }
  let insert = prefix + text + suffix
  const recognized = () => nodes(parser.parse(source.slice(0, from) + insert + source.slice(to)) as Node)
    .some(node => node.type === type && start(node) === from && end(node) === from + insert.length)
  // Les suites *** peuvent changer l'imbrication. L'autre délimiteur conserve alors
  // une enveloppe exacte, dont l'inverse reste reconnaissable.
  if (!recognized() && action !== 'code') {
    prefix = suffix = action === 'bold' ? '__' : '_'
    insert = prefix + text + suffix
  }
  if (!recognized()) return { reason: 'Les délimiteurs seraient ambigus à cette frontière de sélection.' }
  return inlineResult(state, root, [
    { from, to: from, insert: prefix },
    { from: to, to, insert: suffix },
  ], from + prefix.length, from + prefix.length + text.length)
}
