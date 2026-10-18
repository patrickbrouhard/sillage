import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconButton } from './IconButton'
import type { TranscriptItem } from './transcriptApi'
import { groupTranscript } from './transcriptPresentation'
import { findTranscriptMatches, highlightTranscript } from './transcriptSearch'
import { selectedTranscript } from './transcriptSelection'
import type { TranscriptExcerpt } from './transcriptSelection'
import { formatDuration } from './videoPresentation'

/** Recherche dans le contenu chargé ; seule l'action sur un timestamp appelle le lecteur. */
export function TranscriptText({ items, onNavigate, onCite, heading, acquisition, feedback }: {
  heading: ReactNode
  acquisition: ReactNode
  feedback: ReactNode
  items: TranscriptItem[]
  onNavigate: (startMs: number) => void
  onCite: (excerpt: TranscriptExcerpt) => void
}) {
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const searchID = useId()
  const searchInput = useRef<HTMLInputElement>(null)
  const searchButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (searchOpen) searchInput.current?.focus()
  }, [searchOpen])

  /** Replier ne modifie ni la requête ni le résultat actif ; le focus revient à la commande. */
  function closeSearch() {
    setSearchOpen(false)
    searchButton.current?.focus()
  }
  const blocks = useMemo(() => groupTranscript(items, 10), [items])
  const text = useMemo(() => items.map(item => item.text).join(''), [items])
  const matches = useMemo(() => findTranscriptMatches(text, query), [text, items, query])
  const parts = useMemo(() => highlightTranscript(blocks, matches), [blocks, matches])
  const [selection, setSelection] = useState({ matches, index: 0 })
  // Toute nouvelle saisie ou actualisation repart de la première occurrence.
  const active = selection.matches === matches ? selection.index : 0
  const container = useRef<HTMLDivElement>(null)

  const citeButton = useRef<HTMLButtonElement>(null)
  const [excerpt, setExcerpt] = useState<{ parts: typeof parts; value: TranscriptExcerpt } | null>(null)
  const [citationMessage, setCitationMessage] = useState('')
  const validExcerpt = excerpt?.parts === parts ? excerpt.value : null

  useLayoutEffect(() => {
    // Un changement de contenu ou de recherche rend les anciennes bornes DOM caduques.
    setExcerpt(null)
    setCitationMessage('')
    const selection = window.getSelection()
    if (selection?.anchorNode && container.current?.contains(selection.anchorNode)) selection.removeAllRanges()
  }, [parts])

  useEffect(() => {
    /** Conserve l'extrait pendant le transfert vers le bouton, jamais vers un autre outil. */
    function updateSelection() {
      const panel = container.current
      const value = panel && selectedTranscript(panel, items)
      if (value) setExcerpt({ parts, value })
      else if (document.activeElement !== citeButton.current) setExcerpt(null)
    }
    /** Un clic hors du texte abandonne l'action, sauf sur son bouton dédié. */
    function dismiss(event: Event) {
      const target = event.target
      if (target instanceof Node && !citeButton.current?.contains(target) && !container.current?.contains(target)) {
        setExcerpt(null)
      }
    }
    /** La copie native utilise la plage vivante, jamais un extrait mémorisé devenu invisible. */
    function copy(event: ClipboardEvent) {
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, [contenteditable=true]')) return
      const panel = container.current
      const value = panel && selectedTranscript(panel, items)
      if (!value || !event.clipboardData) return
      event.clipboardData.setData('text/plain', value.text)
      event.preventDefault()
    }
    document.addEventListener('selectionchange', updateSelection)
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('focusin', dismiss)
    document.addEventListener('copy', copy)
    return () => {
      document.removeEventListener('selectionchange', updateSelection)
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('focusin', dismiss)
      document.removeEventListener('copy', copy)
    }
  }, [items, parts])

  /** Consomme une sélection une seule fois, même si l'insertion doit être refusée. */
  function cite() {
    if (!validExcerpt) return
    setExcerpt(null)
    window.getSelection()?.removeAllRanges()
    try {
      onCite(validExcerpt)
      setCitationMessage('Citation insérée dans la note.')
    } catch (error) {
      setCitationMessage(error instanceof Error ? error.message : 'Impossible d’insérer la citation.')
    }
  }

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
    <div className="transcript-heading">
      {heading}
      <div className="transcript-actions">
        <IconButton icon="search" label="Rechercher dans la transcription" ref={searchButton}
          tooltip={query ? 'Rechercher dans la transcription — recherche active' : 'Rechercher dans la transcription'}
          className={query ? 'search-active' : ''} aria-expanded={searchOpen} aria-controls={searchID}
          onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)} />
        {acquisition}
        <IconButton icon="quote" label="Citer dans la note" ref={citeButton} disabled={!validExcerpt}
          tooltip={validExcerpt ? 'Citer la sélection dans la note' : 'Sélectionnez un extrait de la transcription pour le citer'}
          onClick={cite} />
      </div>
    </div>
    {feedback}
    <div className="transcript-search" id={searchID} hidden={!searchOpen}
      onKeyDown={event => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
          event.preventDefault()
          closeSearch()
        }
      }}>
      <label><span className="sr-only">Rechercher dans la transcription</span>
        <input ref={searchInput} type="search" placeholder="Rechercher dans la transcription" value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            // Entrée de validation IME ne doit pas déclencher une navigation.
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              navigate(1)
            }
          }} />
      </label>
      <span role="status" aria-label="Occurrences">{query
        ? matches.length ? `${active + 1} / ${matches.length}` : 'Aucun résultat'
        : ''}</span>
      <IconButton icon="previous" disabled={!matches.length} onClick={() => navigate(-1)} label="Occurrence précédente" />
      <IconButton icon="next" disabled={!matches.length} onClick={() => navigate(1)} label="Occurrence suivante" />
      <IconButton icon="clear" disabled={!query} label="Effacer la recherche" onClick={() => {
        setQuery('')
        searchInput.current?.focus()
      }} />
    </div>
    {citationMessage && <p role="status">{citationMessage}</p>}
    <div className="transcript-content" ref={container} tabIndex={0} aria-label="Texte de la transcription">
      {blocks.map((block, index) => <div className="transcript-block" key={index}>
        <button type="button" className="transcript-time"
          aria-label={`Aller à ${formatDuration(block.start_ms)} dans le lecteur`}
          onClick={() => onNavigate(block.start_ms)}>
          {formatDuration(block.start_ms)}
        </button>
        <p data-transcript-text>{parts[index].map((part, partIndex) => part.matchIndex === undefined
          ? part.text
          : <mark key={partIndex} data-match-index={part.matchIndex}
            className={part.matchIndex === active ? 'transcript-match-active' : undefined}
            aria-current={part.matchIndex === active ? 'true' : undefined}>{part.text}</mark>)}</p>
      </div>)}
    </div>
  </>
}
