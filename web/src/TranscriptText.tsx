import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconButton } from './IconButton'
import { TranscriptSelectionToolbar } from './TranscriptSelectionToolbar'
import type { TranscriptItem } from './transcriptApi'
import { groupTranscript } from './transcriptPresentation'
import { findTranscriptMatches, highlightTranscript } from './transcriptSearch'
import { selectedTranscript } from './transcriptSelection'
import type { TranscriptExcerpt } from './transcriptSelection'
import { formatDuration } from './videoPresentation'

/** Compare les bornes documentaires sans dépendre du sens ni du texte répété de la sélection. */
function sameRange(left: Range | null | undefined, right: Range | null | undefined): boolean {
  return Boolean(left && right && left.startContainer === right.startContainer &&
    left.startOffset === right.startOffset && left.endContainer === right.endContainer && left.endOffset === right.endOffset)
}

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
  type SelectionTarget = { parts: typeof parts; value: TranscriptExcerpt; range: Range }
  const [excerpt, setExcerpt] = useState<SelectionTarget | null>(null)
  const [actions, setActions] = useState<SelectionTarget | null>(null)
  const target = useRef<SelectionTarget | null>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const dismissedRange = useRef<Range | null>(null)
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Un remplacement du contenu réinstalle les écouteurs, mais ne termine pas le geste natif.
  const interaction = useRef({ dragging: false, touching: false, touch: false })
  const [citationMessage, setCitationMessage] = useState('')
  const validExcerpt = excerpt?.parts === parts ? excerpt.value : null

  useLayoutEffect(() => {
    // Un changement de contenu ou de recherche rend les anciennes bornes DOM caduques.
    target.current = null
    dismissedRange.current = null
    clearTimeout(showTimer.current)
    setExcerpt(null)
    setActions(null)
    setCitationMessage('')
    const selection = window.getSelection()
    if (selection?.anchorNode && container.current?.contains(selection.anchorNode)) selection.removeAllRanges()
  }, [parts])

  /** Ferme la barre pour cette plage, sans effacer la sélection ni reprendre un focus extérieur. */
  function closeActions() {
    clearTimeout(showTimer.current)
    dismissedRange.current = target.current?.range ?? dismissedRange.current
    // Si la barre disparaît avec un bouton focalisé, conserver un point de reprise clavier
    // dans le texte ; une sortie de fenêtre ou un focus extérieur ne doit pas être repris.
    if (document.hasFocus() && toolbar.current?.contains(document.activeElement)) {
      container.current?.focus({ preventScroll: true })
    }
    setActions(null)
  }

  useEffect(() => {
    const gesture = interaction.current

    /** Attend la fin du geste et vérifie de nouveau la plage vivante avant d'afficher les actions. */
    function schedule() {
      clearTimeout(showTimer.current)
      const expected = target.current
      if (gesture.dragging || !expected || sameRange(dismissedRange.current, expected.range)) return
      showTimer.current = setTimeout(() => {
        const native = window.getSelection()
        if (!gesture.dragging && target.current === expected && native?.rangeCount === 1 &&
            sameRange(native.getRangeAt(0), expected.range)) setActions(expected)
      }, gesture.touch ? 600 : 180)
    }

    /** Une nouvelle plage invalide immédiatement le menu ; le transfert de focus garde la même cible. */
    function updateSelection() {
      const panel = container.current
      const native = window.getSelection()
      const value = panel && selectedTranscript(panel, items)
      if (value && native?.rangeCount === 1) {
        const range = native.getRangeAt(0)
        // Une notification déjà en file ne réarme pas une plage abandonnée pour une autre surface.
        if (sameRange(dismissedRange.current, range)) return
        dismissedRange.current = null
        if (target.current?.parts === parts && sameRange(target.current.range, range)) return
        target.current = { parts, value, range: range.cloneRange() }
        setExcerpt(target.current)
        setActions(null)
        schedule()
      } else {
        clearTimeout(showTimer.current)
        setActions(null)
        // Le bouton historique conserve son extrait pendant le seul transfert de focus autorisé.
        if (document.activeElement !== citeButton.current || (native && !native.isCollapsed)) {
          target.current = null
          dismissedRange.current = null
          setExcerpt(null)
        }
      }
    }

    /** Préserve les contrôles de citation, mais invalide un extrait abandonné pour une autre surface. */
    function dismiss(event: Event) {
      const node = event.target
      if (!(node instanceof Node) || toolbar.current?.contains(node) || citeButton.current?.contains(node)) return
      if (container.current?.contains(node)) {
        if (node instanceof Element && node.closest('.transcript-time')) {
          closeActions()
          return
        }
        if (event.type === 'pointerdown') {
          gesture.dragging = true
          gesture.touch = (event as PointerEvent).pointerType === 'touch'
          clearTimeout(showTimer.current)
          dismissedRange.current = null
          setActions(null)
        }
        return
      }
      clearTimeout(showTimer.current)
      dismissedRange.current = target.current?.range ?? dismissedRange.current
      target.current = null
      setExcerpt(null)
      setActions(null)
    }

    /** La sélection finale appartient au navigateur, y compris pour le glisser inversé et les poignées tactiles. */
    function endGesture() {
      if (!gesture.dragging || gesture.touching) return
      gesture.dragging = false
      updateSelection()
      schedule()
    }

    /** Un menu natif ou un scroll peut annuler le pointeur avant que les doigts soient relevés. */
    function startTouch(event: TouchEvent) {
      if (!container.current?.contains(event.target as Node)) return
      gesture.touching = true
      gesture.dragging = true
      gesture.touch = true
      clearTimeout(showTimer.current)
      setActions(null)
    }

    function endTouch(event: TouchEvent) {
      gesture.touching = event.touches.length > 0
      if (!gesture.touching) endGesture()
    }

    function cancelGesture() {
      if (gesture.touching) return
      gesture.dragging = false
      closeActions()
    }

    function blur() {
      gesture.touching = false
      cancelGesture()
    }

    /** Tab donne accès aux actions sans voler le focus à l'apparition ; Échap rend le texte au clavier. */
    function keydown(event: KeyboardEvent) {
      const inToolbar = toolbar.current?.contains(event.target as Node)
      const inText = container.current?.contains(event.target as Node)
      if (!inToolbar && !inText) return
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault()
        closeActions()
      } else if (inText && /^(Arrow|Home|End|Page)/.test(event.key)) {
        // Fermer avant la mutation native évite de focaliser une barre visant encore l'ancienne plage.
        clearTimeout(showTimer.current)
        gesture.touch = false
        setActions(null)
      } else if (event.key === 'Tab' && !event.shiftKey && inText && toolbar.current) {
        event.preventDefault()
        toolbar.current.querySelector('button')?.focus({ preventScroll: true })
      }
    }

    /** La copie native utilise la plage vivante, jamais un extrait mémorisé devenu invisible. */
    function copy(event: ClipboardEvent) {
      const node = event.target
      if (node instanceof Element && node.closest('input, textarea, [contenteditable=true]')) return
      const panel = container.current
      const value = panel && selectedTranscript(panel, items)
      if (!value || !event.clipboardData) return
      event.clipboardData.setData('text/plain', value.text)
      event.preventDefault()
    }
    document.addEventListener('selectionchange', updateSelection)
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('focusin', dismiss)
    document.addEventListener('keydown', keydown)
    document.addEventListener('copy', copy)
    document.addEventListener('touchstart', startTouch, { passive: true })
    window.addEventListener('touchend', endTouch)
    window.addEventListener('touchcancel', endTouch)
    window.addEventListener('pointerup', endGesture)
    window.addEventListener('pointercancel', cancelGesture)
    window.addEventListener('blur', blur)
    return () => {
      clearTimeout(showTimer.current)
      document.removeEventListener('selectionchange', updateSelection)
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('focusin', dismiss)
      document.removeEventListener('keydown', keydown)
      document.removeEventListener('copy', copy)
      document.removeEventListener('touchstart', startTouch)
      window.removeEventListener('touchend', endTouch)
      window.removeEventListener('touchcancel', endTouch)
      window.removeEventListener('pointerup', endGesture)
      window.removeEventListener('pointercancel', cancelGesture)
      window.removeEventListener('blur', blur)
    }
  }, [items, parts])

  /** Revalide la cible contextuelle au moment de l'action, même avant un selectionchange différé. */
  function contextAction(action: 'cite' | 'search') {
    const native = window.getSelection()
    if (!actions || actions !== excerpt || actions.parts !== parts || native?.rangeCount !== 1 ||
        !sameRange(actions.range, native.getRangeAt(0)) || !container.current?.contains(actions.range.startContainer)) {
      closeActions()
      target.current = null
      dismissedRange.current = null
      setExcerpt(null)
      return
    }
    if (action === 'cite') { cite(); return }
    const value = actions.value.text
    closeActions()
    target.current = null
    setExcerpt(null)
    window.getSelection()?.removeAllRanges()
    setQuery(value)
    // Une requête identique doit aussi repartir du premier résultat et retrouver son défilement.
    setSelection({ matches, index: 0 })
    setSearchOpen(true)
    if (searchOpen) searchInput.current?.focus()
  }

  /** Consomme une sélection une seule fois, même si l'insertion doit être refusée. */
  function cite() {
    const native = window.getSelection()
    // Le focus du bouton peut replier la plage, mais une autre sélection non vide
    // invalide l'extrait, même avant sa notification selectionchange.
    const changed = native && !native.isCollapsed &&
      (native.rangeCount !== 1 || !sameRange(excerpt?.range, native.getRangeAt(0)))
    if (!validExcerpt || changed) {
      closeActions()
      target.current = null
      setExcerpt(null)
      return
    }
    closeActions()
    target.current = null
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
          tooltip={validExcerpt ? 'Citer dans la note' : 'Citer dans la note — Sélectionnez un extrait de la transcription pour le citer'}
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
    {actions && actions === excerpt && actions.parts === parts && <TranscriptSelectionToolbar
      range={actions.range} container={container} toolbar={toolbar} onClose={closeActions}
      onCite={() => contextAction('cite')} onSearch={() => contextAction('search')} />}
  </>
}
