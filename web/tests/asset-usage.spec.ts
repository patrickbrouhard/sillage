import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { test, expect } from './fixtures'
import { countAssetImages } from '../src/assetUsage'
import { assetIDFromURL } from '../src/assetApi'
import { remarkCallouts } from '../src/remarkCallouts'

const url = '/api/v1/assets/800/content'
const cases: [string, string, number][] = [
  ['directes', `![a](${url}) ![b](<${url}> "titre")`, 2],
  ['références répétées et casse', `![a][IMAGE] ![b][image] ![image][] ![image]\n\n[image]: ${url}`, 4],
  ['références absentes ou inutilisées', `![absente]\n\n[unused]: ${url}`, 0],
  ['texte et liens', `${url}\n\n[lien](${url})\n\n<${url}>`, 0],
  ['code inline et blocs', `\`![a](${url})\`\n\n\`\`\`md\n![b](${url})\n\`\`\`\n\n    ![c](${url})`, 0],
  ['échappement', `\\![a](${url})`, 0],
  ['citation, liste et image dans un lien', `> ![a](${url})\n\n- ![b](${url})\n\n[![c](${url})](https://example.test)`, 3],
  ['HTML brut', `<img src="${url}">`, 0],
  ['URL non canonique', '![a](/api/v1/assets/0800/content) ![b](/api/v1/assets/800/content?x=1) ![c](https://example.test/api/v1/assets/800/content)', 0],
  ['callout avec en-tête littéral', `> [!quote] ![a](${url})\n> ![b](${url})`, 1],
  ['en-tête rejeté inerte', `> [!quote:tr] ![a](${url})\n> ![b](${url})`, 1],
  ['note de bas de page réutilisée', `Texte[^a] puis[^a].\n\n[^a]: ![a](${url})\n\n[^unused]: ![b](${url})`, 1],
]

for (const [label, escapedContent, expected] of cases) {
  test(`compte les images rendues : ${label}`, () => {
    const content = escapedContent.replaceAll('\\n', '\n').replaceAll('\\`', '`')
    const rendered: number[] = []
    renderToStaticMarkup(createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, remarkCallouts], skipHtml: true,
      components: { img: ({ src }) => {
        const id = assetIDFromURL(src)
        if (id !== null) rendered.push(id)
        return createElement('img', { src })
      } },
    }, content))
    expect(rendered.filter(id => id === 800)).toHaveLength(expected)
    expect(countAssetImages(content).get(800) ?? 0).toBe(expected)
  })
}
