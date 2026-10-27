import { AssetImage } from './AssetImage'
import { assetIDFromURL } from './assetApi'
import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import type { Components } from 'react-markdown'
import { parseTemporalReference } from './temporalReference'
import type { TemporalReference } from './temporalReference'
import { formatDuration } from './videoPresentation'
import remarkGfm from 'remark-gfm'
import { Link } from 'react-router'
import { remarkCallouts } from './remarkCallouts'
import { QuoteCallout } from './QuoteCallout'

/** Garde le retour de navigation près de son action, sans toucher à la session de note. */
function TimeButton({ reference, children, onNavigate }: {
  reference: TemporalReference
  children: ReactNode
  onNavigate: (reference: TemporalReference) => string
}) {
  const [message, setMessage] = useState('')
  const descriptionID = useId()
  return <span>
    <button type="button" className="temporal-reference"
      aria-describedby={descriptionID}
      onClick={() => setMessage(onNavigate(reference))}>
      <span className="temporal-reference-content">
        <span className="temporal-reference-icon" aria-hidden="true">◷</span>{children}
      </span>
    </button>
    <span id={descriptionID} className="sr-only">Aller à {formatDuration(reference.startMs)} dans le lecteur</span>
    {message && <span role="status" className="temporal-message"> {message}</span>}
  </span>
}

/** Rend le GFM sans HTML brut ; les liens internes utilisent la navigation protégée. */
export function MarkdownReading({ content, onNavigate }: {
  content: string
  onNavigate: (reference: TemporalReference) => string
}) {
  // Un changement d'état de sauvegarde ne doit pas remonter l'action focalisée.
  const components = useMemo<Components>(() => ({
    blockquote: ({ node, children }) => {
      const kind = node?.properties['data-callout']
      if (kind === 'quote') return <QuoteCallout transcript={false}
        attribution={String(node?.properties['data-attribution'] ?? '')}>{children}</QuoteCallout>
      const uri = node?.properties['data-reference']
      const reference = kind === 'quote:tr' && typeof uri === 'string'
        ? parseTemporalReference(uri) : null
      if (reference) return <QuoteCallout transcript
        title={String(node?.properties['data-title'] ?? '')}
        action={<TimeButton key={String(uri)} reference={reference} onNavigate={onNavigate}>
          {formatDuration(reference.startMs)}
        </TimeButton>}>{children}</QuoteCallout>
      return <blockquote>{children}</blockquote>
    },
    img: ({ src, alt }) => {
      const id = assetIDFromURL(src)
      return id === null ? <img src={src} alt={alt} /> : <AssetImage key={id} id={id} alt={alt} />
    },
    a: ({ href, children }) => {
      if (!href) return <span>{children}</span>
      const reference = parseTemporalReference(href)
      if (reference) return <TimeButton key={href} reference={reference}
        onNavigate={onNavigate}>{children}</TimeButton>
      let url: URL
      try { url = new URL(href, window.location.href) } catch { return <span>{children}</span> }
      if (url.origin === window.location.origin) {
        return <Link to={url.pathname + url.search + url.hash}>{children}</Link>
      }
      const externalWeb = url.protocol === 'http:' || url.protocol === 'https:'
      return <a href={href} target={externalWeb ? '_blank' : undefined}
        rel="noopener noreferrer">{children}</a>
    },
  }), [onNavigate])
  return <div className="markdown-reading" aria-label="Lecture de la note">
    {content ? <ReactMarkdown remarkPlugins={[remarkGfm, remarkCallouts]} skipHtml
      urlTransform={(value, key, node) =>
        key === 'href' && node.tagName === 'a' && parseTemporalReference(value)
          ? value : defaultUrlTransform(value)}
      components={components}>{content}</ReactMarkdown> : <p>Note vide.</p>}
  </div>
}
