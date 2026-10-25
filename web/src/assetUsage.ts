import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import type { Root, Element } from 'hast'
import { remarkCallouts } from './remarkCallouts'
import { assetIDFromURL } from './assetApi'

// La même chaîne résout références, notes de bas de page et en-têtes de callout comme la lecture.
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkCallouts).use(remarkRehype).freeze()

/** Compte les images internes réellement rendues, sans React, requête réseau ou écriture. */
export function countAssetImages(content: string): ReadonlyMap<number, number> {
  const tree = parser.runSync(parser.parse(content), content) as Root
  const counts = new Map<number, number>()
  function visit(node: Root | Element) {
    if (node.type === 'element' && node.tagName === 'img') {
      const id = assetIDFromURL(String(node.properties.src ?? ''))
      if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    for (const child of node.children) {
      if (child.type === 'element') visit(child)
    }
  }
  visit(tree)
  return counts
}
