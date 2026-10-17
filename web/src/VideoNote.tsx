import { assetMarkdown, createCapture } from './assetApi'
import type { CaptureTarget } from './assetApi'
import { useAsset } from './useAsset'
import { formatDuration } from './videoPresentation'
import { lazy, Suspense, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react'
import type { Ref } from 'react'
import { useBlocker } from 'react-router'
import { MarkdownEditor } from './MarkdownEditor'
import type { MarkdownEditorHandle } from './MarkdownEditor'
import type { TemporalReference } from './temporalReference'
import { NoteSession } from './noteSession'

const MarkdownReading = lazy(() => import('./MarkdownReading').then(module => ({ default: module.MarkdownReading })))

/** Expose seulement l'insertion de citation à la fiche, sans reconstruire la session. */
export interface VideoNoteHandle {
  /** Refuse la lecture ou une session indisponible avant toute modification. */
  insertCitation(markdown: string): void
}

/** Présente une note locale et son état confirmé, avec modes partageant la même source. */
export function VideoNote({ videoID, getTimeReference, getCaptureTarget, onNavigate, ref }: {
  videoID: number
  getTimeReference: () => string
  getCaptureTarget: () => CaptureTarget
  onNavigate: (reference: TemporalReference) => string
  ref?: Ref<VideoNoteHandle>
}) {
  const editor = useRef<MarkdownEditorHandle>(null)
  const [navigationMessage, setNavigationMessage] = useState('')
  const [insertionError, setInsertionError] = useState('')
  const [session] = useState(() => new NoteSession(videoID))
  const state = useSyncExternalStore(session.subscribe, session.snapshot)
  const [accepting, setAccepting] = useState(false)
  const [captureID, setCaptureID] = useState<number | null>(null)
  const [captureError, setCaptureError] = useState('')
  const captureRequest = useRef<AbortController | null>(null)
  const captureState = useAsset(captureID)
  const captureBusy = accepting || (captureID !== null && (!captureState.asset || captureState.asset.status === 'pending'))
  useEffect(() => () => captureRequest.current?.abort(), [])
  const [reading, setReading] = useState(false)
  const [initial, setInitial] = useState<{ content: string; version: number } | null>(null)
  useImperativeHandle(ref, () => ({
    insertCitation(markdown) {
      if (reading) throw new Error('Passez en Édition, placez le curseur dans la note, puis recommencez la sélection de transcription.')
      if (!editor.current) throw new Error('La note n’est pas disponible. Recommencez la sélection une fois prête.')
      editor.current.insertCitation(markdown)
    },
  }))
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    session.unconfirmed && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search))
  const leaveDialog = useRef<HTMLDialogElement>(null)
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    void session.start()
    return () => session.stop()
  }, [session])
  useEffect(() => {
    if (state.loaded && initial?.version !== state.editorVersion) {
      setInitial({ content: state.content, version: state.editorVersion })
    }
  }, [state.loaded, state.content, state.editorVersion, initial])

  useEffect(() => {
    if (blocker.state !== 'blocked') { leaveDialog.current?.close(); return }
    let canceled = false
    leaveDialog.current?.showModal()
    setLeaving(true)
    void session.flush().then(confirmed => {
      if (canceled) return
      setLeaving(false)
      if (confirmed) blocker.proceed()
    })
    return () => { canceled = true; leaveDialog.current?.close() }
    // Une tentative par destination : un échec attend un choix, pas une boucle de réessais.
  }, [blocker.state, blocker.location?.key, session])

  useEffect(() => {
    if (!session.unconfirmed) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [session, state])

  // Le raccourci fonctionne aussi en Lecture et ne déclenche jamais le dialogue du navigateur.
  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault(); void session.save(true)
      }
    }
    window.addEventListener('keydown', save)
    return () => window.removeEventListener('keydown', save)
  }, [session])

  const status = state.phase === 'saving' ? 'Enregistrement…'
    : state.phase === 'error' || state.phase === 'conflict' ? state.message
    : session.dirty ? 'Modifications en attente'
    : state.confirmed ? 'Enregistré' : 'Aucune note enregistrée'

  /** Lit le temps au clic et laisse la transaction CodeMirror déclencher la sauvegarde normale. */
  function insertTime() {
    try {
      if (!editor.current || reading) throw new Error('L’éditeur n’est pas disponible.')
      const reference = getTimeReference()
      editor.current.insert(reference + ' ')
      setInsertionError('')
    } catch (error) {
      setInsertionError(error instanceof Error ? error.message : 'Temps indisponible : aucune référence insérée.')
    }
  }

  /** L'intention appartient à l'éditeur courant ; le serveur poursuit seul après son départ. */
  async function insertCapture() {
    if (captureBusy || captureRequest.current || reading || !editor.current) return
    const currentEditor = editor.current
    const controller = new AbortController()
    const requestID = crypto.randomUUID()
    try {
      const target = getCaptureTarget()
      const label = formatDuration(target.timestampMs)
      currentEditor.beginCapture(requestID, 'Capture à ' + label + ' — préparation…')
      captureRequest.current = controller
      setAccepting(true)
      setCaptureError('')
      setCaptureID(null)
      const result = await createCapture(target, requestID, controller.signal)
      if (controller.signal.aborted) return
      // Le handle capturé vise l'ancienne vue si un conflit a remplacé la session.
      const inserted = currentEditor.finishCapture(requestID, assetMarkdown(result, label))
      setCaptureID(result.id)
      if (!inserted) setCaptureError('Capture acceptée, mais insertion abandonnée : son emplacement n’existe plus dans cette session.')
    } catch (error) {
      currentEditor.abandonCapture(requestID)
      if (!controller.signal.aborted) setCaptureError(error instanceof Error ? error.message : 'Capture non confirmée.')
    } finally {
      if (captureRequest.current === controller) captureRequest.current = null
      if (!controller.signal.aborted) setAccepting(false)
    }
  }

  return <section className="video-note" aria-labelledby="note-title">
    <h2 id="note-title">Note</h2>
    {!state.loaded ? <>
      <p role="status">{state.message || 'Chargement de la note…'}</p>
      {state.message && <button className="button" onClick={() => void session.start()}>Relire la note</button>}
    </> : <>
      <div className="note-toolbar" aria-label="Mode de la note">
        <button className="button" aria-pressed={!reading} onClick={() => setReading(false)}>Édition</button>
        <button className="button" aria-pressed={reading} disabled={accepting} onClick={() => setReading(true)}>Lecture</button>
        <button className="button" disabled={reading || initial === null} onClick={insertTime}>+ Temps</button>
        <button className="button" disabled={reading || initial === null || captureBusy}
          aria-busy={captureBusy} onClick={() => void insertCapture()}>{captureBusy ? 'Capture en cours…' : '+ Capture'}</button>
        <button className="button" disabled={state.phase === 'conflict'}
          onClick={() => void session.save(true)}>{state.phase === 'error' ? 'Réessayer la sauvegarde' : 'Enregistrer la note'}</button>
      </div>
      {captureError && <p role="alert">{captureError}</p>}
      {captureState.error && <p role="status">{captureState.error}</p>}
      {captureState.asset?.status === 'failed' && <p role="alert">La génération de la capture a échoué ou a été interrompue. Sa référence est conservée dans la note.</p>}
      {insertionError && <p role="alert">{insertionError}</p>}
      <div role="status" aria-label="Navigation temporelle" hidden={reading}>{navigationMessage}</div>
      <div hidden={reading}>
        {initial !== null && <MarkdownEditor
          ref={editor}
          key={initial.version}
          initial={initial.content}
          active={!reading}
          onNavigate={reference => setNavigationMessage(onNavigate(reference))}
          onChange={session.change}
          onSave={() => void session.save(true)}
        />}
      </div>
      {reading && <Suspense fallback={<p>Préparation de la lecture…</p>}><MarkdownReading content={state.content} onNavigate={onNavigate} /></Suspense>}
      <p role="status" aria-label="État de la note">{status}</p>
      {state.phase === 'conflict' && <div className="note-conflict" role="region" aria-label="Résolution du conflit">
        <p>L’autosauvegarde est suspendue. Choisissez explicitement la version à conserver.</p>
        <h3>Votre version locale</h3>
        <pre>{state.content || '(note vide)'}</pre>
        <h3>Version serveur</h3>
        {state.remote === undefined ? <p>Version serveur non disponible.</p> : <>
          <p>{state.remote ? `Révision ${state.remote.revision}` : 'Aucune note enregistrée.'}</p>
          <pre>{state.remote?.content_md || '(note vide)'}</pre>
        </>}
        <div className="note-toolbar">
          <button className="button" onClick={() => void session.readConflict()}>Actualiser la version serveur</button>
          <button className="button" disabled={state.remote === undefined} onClick={session.useServer}>Conserver la version serveur</button>
          <button className="button" disabled={state.remote === undefined} onClick={() => void session.keepLocal()}>Conserver ma version locale</button>
        </div>
      </div>}
      {state.confirmed && <p className="muted">Dernier contenu confirmé : révision {state.confirmed.revision} · <time dateTime={state.confirmed.updated_at}>{new Date(state.confirmed.updated_at).toLocaleTimeString('fr-FR')}</time></p>}
    </>}
    <dialog ref={leaveDialog} className="note-navigation" aria-labelledby="leave-note-title"
      onCancel={event => { event.preventDefault(); if (blocker.state === 'blocked') blocker.reset() }}>
      <h2 id="leave-note-title">Quitter la note ?</h2>
      <p>{leaving ? 'Tentative de sauvegarde avant le départ…' : 'Les modifications ne sont pas confirmées. Quitter peut perdre votre texte local.'}</p>
      <div className="note-toolbar">
        <button className="button" onClick={() => { if (blocker.state === 'blocked') blocker.reset() }}>Rester sur la note</button>
        <button className="button" onClick={() => { if (blocker.state === 'blocked') blocker.proceed() }}>Quitter malgré le risque</button>
      </div>
    </dialog>
  </section>
}
