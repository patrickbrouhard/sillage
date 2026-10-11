import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Link } from 'react-router'

/** Rend le GFM sans HTML brut ; les liens internes utilisent la navigation protégée. */
export function MarkdownReading({ content }: { content: string }) {
  return <div className="markdown-reading" aria-label="Lecture de la note">
    {content ? <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
      a: ({ href, children }) => {
        if (!href) return <span>{children}</span>
        let url: URL
        try { url = new URL(href, window.location.href) } catch { return <span>{children}</span> }
        if (url.origin === window.location.origin) {
          return <Link to={url.pathname + url.search + url.hash}>{children}</Link>
        }
        return <a href={href} rel="noopener noreferrer">{children}</a>
      },
    }}>{content}</ReactMarkdown> : <p>Note vide.</p>}
  </div>
}
