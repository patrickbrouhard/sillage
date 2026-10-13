import { useEffect, useMemo, useRef, useState } from 'react'
import type { TranscriptItem } from './transcriptApi'
import { groupTranscript } from './transcriptPresentation'
import { findTranscriptMatches, highlightTranscript } from './transcriptSearch'
import { formatDuration } from './videoPresentation'

/** Recherche dans le contenu chargé ; seule l'action sur un timestamp appelle le lecteur. */
export function TranscriptText({ items, onNavigate }: {
  items: TranscriptItem[]
  onNavigate: (startMs: number) => void
}) {
  const [query, setQuery] = useState('')
  const blocks = useMemo(() => groupTranscript(items, 10), [items])
  const text = useMemo(() => items.map(item => item.text).join(''), [items])
  const matches = useMemo(() => findTranscriptMatches(text, query), [text, items, query])
  const parts = useMemo(() => highlightTranscript(blocks, matches), [blocks, matches])
  const [selection, setSelection] = useState({ matches, index: 0 })
  // Toute nouvelle saisie ou actualisation repart de la première occurrence.
  const active = selection.matches === matches ? selection.index : 0
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const panel = container.current
    const result = panel?.querySelector<HTMLElement>(`[data-match-index="${active}"]`)
    if (!panel || !result) return
    if (panel.scrollHeight > panel.clientHeight) {
      // Sur desktop, faire défiler uniquement la transcription, sans déplacer la note.
      const panelBox = panel.getBoundingClientRect()
      const resultBox = result.getBoundingClientRect()
      panel.scrollTop += resultBox.top - panelBox.top - panel.clientHeight / 2
    } else {
      // Sur mobile, la transcription participe au défilement normal de la page.
      result.scrollIntoView({ block: 'nearest' })
    }
  }, [matches, active, selection])

  /** Sélectionne immédiatement une occurrence avec retour circulaire. */
  function navigate(delta: number) {
    if (matches.length) setSelection({
      matches,
      index: (active + delta + matches.length) % matches.length,
    })
  }

  return <>
    <div className="transcript-search">
      <label><span className="sr-only">Rechercher dans la transcription</span>
        <input type="search" placeholder="Rechercher dans la transcription" value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            // Entrée de validation IME ne doit pas déclencher une navigation.
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              navigate(1)
            }
          }} />
      </label>
      <span role="status" aria-label="Occurrences">{matches.length ? active + 1 : 0} / {matches.length}</span>
      <button className="button" disabled={!matches.length} onClick={() => navigate(-1)}
        aria-label="Occurrence précédente">Précédent</button>
      <button className="button" disabled={!matches.length} onClick={() => navigate(1)}
        aria-label="Occurrence suivante">Suivant</button>
    </div>
    <div className="transcript-content" ref={container} tabIndex={0} aria-label="Texte de la transcription">
      {blocks.map((block, index) => <div className="transcript-block" key={index}>
        <button type="button" className="transcript-time"
          aria-label={`Aller à ${formatDuration(block.start_ms)} dans le lecteur`}
          onClick={() => onNavigate(block.start_ms)}>
          {formatDuration(block.start_ms)}
        </button>
        <p>{parts[index].map((part, partIndex) => part.matchIndex === undefined
          ? part.text
          : <mark key={partIndex} data-match-index={part.matchIndex}
            className={part.matchIndex === active ? 'transcript-match-active' : undefined}
            aria-current={part.matchIndex === active ? 'true' : undefined}>{part.text}</mark>)}</p>
      </div>)}
    </div>
  </>
}
