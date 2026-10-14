import type { Blockquote, Root } from 'mdast'
import type { Parent } from 'unist'
import type { Processor } from 'unified'
import type { VFile } from 'vfile'
import { parseTemporalReference } from './temporalReference'

interface Header {
  start: number
  end: number
  literal: string
  attribution?: string
  uri?: string
}

/** Enrichit seulement les deux citations, sans modifier la source ni réserver les variantes inconnues. */
export function remarkCallouts(this: Processor) {
  const processor = this
  return (tree: Root, file: VFile) => {
    const source = String(file)
    const headers = new Map<number, Header>()
    const inertRanges: { start: number; end: number }[] = []
    const prefixes = new Map<number, { start: number; end: number; text: string }>()
    const lines = [...source.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)]

    /** Explicite les continuations paresseuses avant de vider la ligne d'en-tête.
     * Sans cela, CommonMark détacherait ces lignes du blockquote devenu vide.
     */
    function preserveContinuations(quote: Blockquote) {
      const position = quote.position!
      const first = lines[position.start.line - 1]
      const prefix = source.slice(first.index, position.start.offset! + 1)
        .replace(/[^> \t]/g, ' ') + ' '
      const depth = prefix.split('>').length - 1
      for (let line = position.start.line; line < position.end.line; line++) {
        const entry = lines[line]
        const existing = entry[0].match(/^[ \t]*(?:>[ \t]*)*/)![0]
        if (existing.split('>').length - 1 >= depth) continue
        const previous = prefixes.get(entry.index)
        if (!previous || previous.text.length < prefix.length) {
          prefixes.set(entry.index, { start: entry.index, end: entry.index + existing.length, text: prefix })
        }
      }
    }

    /** Une destination commencée dans l'en-tête ne doit pas renaître comme autolien GFM. */
    function collectCrossingLinks(parent: Parent, start: number, end: number) {
      for (const node of parent.children) {
        const from = node.position?.start.offset
        const to = node.position?.end.offset
        if (from !== undefined && to !== undefined && from >= start && from < end && to > end &&
            ['link', 'linkReference', 'image', 'imageReference', 'definition', 'html'].includes(node.type)) {
          inertRanges.push({ start: from, end: to })
        }
        if ('children' in node) collectCrossingLinks(node as Parent, start, end)
      }
    }

    /** L'arbre d'origine détermine le contexte, avant tout retrait d'en-tête. */
    function collect(parent: Parent, quoted: boolean) {
      for (const node of parent.children) {
        if (node.type === 'blockquote') {
          const quote = node as Blockquote
          const first = quote.children[0]
          const position = first?.position
          const quoteStart = quote.position?.start.offset
          if (position && quoteStart !== undefined && position.start.offset !== undefined &&
              position.start.line === quote.position?.start.line &&
              first.type !== 'code' && first.type !== 'html') {
            const literal = source.slice(position.start.offset).split(/\r\n|\r|\n/, 1)[0]
            // « quote:autre » reste inconnu ; une déclaration connue incomplète est neutralisée.
            if (/^\[!quote(?=\]|[ \t(]|$)|^\[!quote:tr(?=\]|[ \t(]|$)/.test(literal)) {
              const ordinary = /^\[!quote\](?:[ \t]+(.*?))?[ \t]*$/.exec(literal)
              const transcript = /^\[!quote:tr\]\(([^\r\n]*)\)[ \t]*$/.exec(literal)
              preserveContinuations(quote)
              collectCrossingLinks(quote, position.start.offset, position.start.offset + literal.length)
              headers.set(quoteStart, {
                start: position.start.offset,
                end: position.start.offset + literal.length,
                literal,
                attribution: !quoted && ordinary ? ordinary[1] ?? '' : undefined,
                uri: !quoted && transcript && parseTemporalReference(transcript[1])
                  ? transcript[1] : undefined,
              })
            }
          }
        }
        if ('children' in node) collect(node as Parent, quoted || node.type === 'blockquote')
      }
    }
    collect(tree, false)
    if (!headers.size) return

    // Isoler les en-têtes avant l'analyse inline empêche liens, code, entités ou
    // titres setext de traverser la frontière avec le corps. Les marqueurs des
    // conteneurs sont conservés, y compris pour les citations vides ou dans une liste.
    const edits = [
      ...[...headers.values()].map(header => ({
        start: header.start, end: header.end, text: ' '.repeat(header.end - header.start),
      })),
      ...prefixes.values(),
    ].sort((a, b) => b.start - a.start)
    let bodySource = source
    for (const edit of edits) {
      bodySource = bodySource.slice(0, edit.start) + edit.text + bodySource.slice(edit.end)
    }
    // Les seuls décalages viennent des préfixes ajoutés aux continuations paresseuses.
    const offsetAfterEdits = (offset: number) => offset + [...prefixes.values()]
      .filter(edit => edit.end <= offset).reduce((delta, edit) => delta + edit.text.length - (edit.end - edit.start), 0)
    const renderedHeaders = new Map([...headers].map(([offset, header]) => [offsetAfterEdits(offset), header]))
    const renderedInertRanges = inertRanges.map(range => ({
      start: offsetAfterEdits(range.start), end: offsetAfterEdits(range.end),
    }))
    // Une seule analyse supplémentaire de la note entière conserve les définitions
    // de liens et notes de bas de page partagées. parse ne relance pas les transforms.
    tree.children = (processor.parse(bodySource) as Root).children

    /** Les données sont internes au rendu ; le repli injecte du texte, jamais du HTML. */
    function decorate(parent: Parent) {
      parent.children = parent.children.flatMap(node => {
        const from = node.position?.start.offset
        const to = node.position?.end.offset
        const inert = from !== undefined && to !== undefined &&
          renderedInertRanges.some(range => from < range.end && to > range.start)
        if (inert && ['link', 'linkReference'].includes(node.type)) return (node as Parent).children
        if (inert && ['image', 'imageReference'].includes(node.type)) {
          return [{ type: 'text', value: (node as { alt?: string }).alt ?? '' }]
        }
        return [node]
      })
      for (const node of parent.children) {
        if (node.type === 'blockquote') {
          const quote = node as Blockquote
          const header = renderedHeaders.get(quote.position?.start.offset ?? -1)
          if (header) {
            if (header.attribution !== undefined || header.uri !== undefined) {
              quote.data = {
                ...quote.data,
                hProperties: header.uri !== undefined
                  ? { 'data-callout': 'quote:tr', 'data-reference': header.uri }
                  : { 'data-callout': 'quote', 'data-attribution': header.attribution! },
              }
            } else {
              // Le texte injecté ne repasse pas par GFM : même HTTP et mailto restent inertes.
              quote.children.unshift({
                type: 'paragraph',
                children: [{ type: 'text', value: header.literal }],
              })
            }
          }
        }
        if ('children' in node) decorate(node as Parent)
      }
    }
    decorate(tree)
  }
}
