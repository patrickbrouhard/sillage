import type { ReactNode } from 'react'

/** Présente les deux citations sans interpréter leur Markdown ni commander le lecteur. */
export function QuoteCallout({ transcript, attribution, action, children }: {
  transcript: boolean
  attribution?: string
  action?: ReactNode
  children: ReactNode
}) {
  return <blockquote className="quote-callout"
    aria-label={transcript ? 'Citation de transcription' : 'Citation'}>
    <div className="quote-callout-header">
      <svg className="quote-callout-icon" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
        aria-hidden="true" focusable="false">
        {transcript
          ? <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9h10M7 13h10M7 17h5" /></>
          : <><path d="M10 6H5v7h5v-7ZM20 6h-5v7h5v-7ZM10 13c0 3-2 5-5 5M20 13c0 3-2 5-5 5" /></>}
      </svg>
      {attribution && <span className="quote-callout-attribution">{attribution}</span>}
      {action && <div className="quote-callout-action">{action}</div>}
    </div>
    <div className="quote-callout-body">{children}</div>
  </blockquote>
}
