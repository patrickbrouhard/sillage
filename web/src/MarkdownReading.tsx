import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import type { Components } from 'react-markdown'
import { parseTemporalReference } from './temporalReference'
import type { TemporalReference } from './temporalReference'
import { formatDuration } from './videoPresentation'
import remarkGfm from 'remark-gfm'
import { Link } from 'react-router'

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
      onClick={() => setMessage(onNavigate(reference))}>{children}</button>
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
      return <a href={href} rel="noopener noreferrer">{children}</a>
    },
  }), [onNavigate])
  return <div className="markdown-reading" aria-label="Lecture de la note">
    {content ? <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml
      urlTransform={(value, key, node) =>
        key === 'href' && node.tagName === 'a' && parseTemporalReference(value)
          ? value : defaultUrlTransform(value)}
      components={components}>{content}</ReactMarkdown> : <p>Note vide.</p>}
  </div>
}
