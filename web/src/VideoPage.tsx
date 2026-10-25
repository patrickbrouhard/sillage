import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { useParams } from 'react-router'
import { APIError, errorMessage, getVideo } from './api'
import type { Tag, Video, VideoSource } from './api'
import type { Asset } from './assetApi'
import { Images, useNarrowWorkspace } from './Images'
import { IconButton } from './IconButton'
import { NoteSession } from './noteSession'
import { VideoTags } from './VideoTags'
import { VideoThumbnail } from './VideoThumbnail'
import { VideoTranscript } from './VideoTranscript'
import { useVideoDownload } from './useVideoDownload'
import { LocalFileDetails } from './LocalFileDetails'
import { VideoPlayer } from './VideoPlayer'
import type { PlayerHandle } from './player'
import type { VideoNoteHandle } from './VideoNote'
import { transcriptCitation } from './transcriptSelection'
import { temporalReference } from './temporalReference'
import { formatDuration, httpURL, providerLabel, workSource } from './videoPresentation'

const VideoNote = lazy(() => import('./VideoNote').then(module => ({ default: module.VideoNote })))

type DetailState =
  | { status: 'loading' }
  | { status: 'ready'; video: Video }
  | { status: 'error'; message: string; missing: boolean }

/** Affiche les métadonnées de chaque provenance sans déduire un auteur du publisher. */
function SourceDetails({ source, index, working }: { source: VideoSource; index: number; working: boolean }) {
  const url = httpURL(source.canonical_url)
  return (
    <section className="source-section" aria-labelledby={`source-${source.id}`}>
      <h2 id={`source-${source.id}`}>Source {index + 1} · {providerLabel(source.provider)}</h2>
      {working && <p className="muted">Source de travail du lecteur et de la transcription</p>}
      <div className="source-overview">
        <VideoThumbnail source={source} />
        <div>
          <h3>{source.title || 'Titre non renseigné'}</h3>
          <dl className="metadata">
            <dt>Identifiant externe</dt>
            <dd>{source.external_id || 'Non renseigné'}</dd>
            <dt>Compte de publication</dt>
            <dd>{source.publisher ? source.publisher.name ?? 'Compte sans nom' : 'Non renseigné'}</dd>
            <dt>Durée</dt>
            <dd>{source.duration_ms == null ? 'Inconnue' : formatDuration(source.duration_ms)}</dd>
          </dl>
          {url ? (
            <a className="button" href={url} target="_blank" rel="noopener noreferrer">
              Ouvrir la source <span className="sr-only">(nouvel onglet)</span> ↗
            </a>
          ) : <p className="muted">Lien externe non disponible</p>}
        </div>
      </div>
      {source.description?.trim() ? <details>
        <summary>Description</summary>
        <p className="description">{source.description}</p>
      </details> : <p className="muted">Aucune description disponible.</p>}
    </section>
  )
}

/** Relit une fiche par son identité Sillage, sans dépendre de la navigation précédente. */
function VideoDetail({ id, titleHost }: { id: string; titleHost: HTMLElement | null }) {
  const [noteSession] = useState(() => new NoteSession(Number(id)))
  const narrow = useNarrowWorkspace()
  const [readingNote, setReadingNote] = useState(false)
  const [imagesOpen, setImagesOpen] = useState(false)
  const [imagesBusy, setImagesBusy] = useState(false)
  const [imagesError, setImagesError] = useState('')
  const imagesReturn = useRef<HTMLElement | null>(null)
  const opening = useRef<symbol | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; opening.current = null } }, [])

  /** Un jeton synchrone empêche les doublons et invalide les retours après fermeture. */
  async function toggleImages() {
    if (imagesOpen || opening.current) { closeImages(); return }
    const request = Symbol()
    opening.current = request
    imagesReturn.current = document.activeElement as HTMLElement | null
    setImagesBusy(true); setImagesError('')
    try {
      await player.current?.prepareImages()
      if (alive.current && opening.current === request) setImagesOpen(true)
    } catch (error) {
      if (alive.current && opening.current === request) {
        player.current?.releaseImages()
        setImagesError(error instanceof Error ? error.message : 'Impossible de préparer Images.')
      }
    } finally {
      if (alive.current && opening.current === request) {
        opening.current = null
        setImagesBusy(false)
      }
    }
  }

  /** Annule aussi une ouverture en préparation, sans reprise du lecteur. */
  function closeImages() {
    opening.current = null
    setImagesBusy(false)
    setImagesOpen(false)
    player.current?.releaseImages()
  }

  const note = useRef<VideoNoteHandle>(null)
  const player = useRef<PlayerHandle>(null)
  const [state, setState] = useState<DetailState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [tab, setTab] = useState<'note' | 'information'>('note')
  const tabButtons = useRef<Array<HTMLButtonElement | null>>([])

  /** Révèle la note avant que l'insertion acceptée mesure et focalise CodeMirror. */
  function revealNote() {
    flushSync(() => setTab('note'))
    tabButtons.current[0]?.focus({ preventScroll: true })
  }
  const source = state.status === 'ready' ? workSource(state.video.sources) : undefined
  const download = useVideoDownload(Number(id), source?.id)
  // Le titre suit la première source REST, indépendamment de la source de travail.
  const title = state.status === 'ready' ? state.video.sources[0]?.title || 'Vidéo sans titre'
    : state.status === 'error' ? state.missing ? 'Vidéo introuvable' : 'Impossible d’ouvrir cette vidéo'
    : 'Fiche vidéo'
  /** Point d'entrée commun : le lecteur décide de la disponibilité et du défilement. */
  function navigate(startMs: number): string {
    const message = player.current?.navigate(startMs) ?? 'Navigation non effectuée : lecteur indisponible.'
    if (!message && imagesOpen) closeImages()
    return message
  }

  function updateTags(tags: Tag[]) {
    setState((current) => current.status === 'ready'
      ? { ...current, video: { ...current.video, tags } }
      : current)
  }

  useEffect(() => {
    const controller = new AbortController()
    void getVideo(id, controller.signal).then(
      (video) => {
        if (!controller.signal.aborted) setState({ status: 'ready', video })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            status: 'error',
            message: errorMessage(error),
            missing: error instanceof APIError && error.code === 'video_not_found',
          })
        }
      },
    )
    return () => controller.abort()
  }, [id, attempt])

  return (
    <>
      <title>{title + ' · Sillage'}</title>
      {/* Le portail garde les données dans la fiche : aucun titre miroir ni requête supplémentaire. */}
      {titleHost && createPortal(<>
        <div className="header-video-title">
          <h1 id="video-title" title={title}>{title}</h1>
          <span className="header-title-measure" aria-hidden="true" inert>{title}</span>
        </div>
        {state.status === 'ready' && <VideoTags title={title} videoID={state.video.id} tags={state.video.tags} onChange={updateTags} />}
      </>, titleHost)}
      {state.status === 'loading' && <div className="state-panel" role="status">Chargement de la vidéo…</div>}
      {state.status === 'error' && (
        <div className="state-panel error" role="alert">
          <p>{state.message}</p>
          {!state.missing && <button className="button" onClick={() => {
            setState({ status: 'loading' })
            setAttempt((value) => value + 1)
          }}>Réessayer</button>}
        </div>
      )}
      {state.status === 'ready' && (
        <>
          <div className={`video-workspace${source ? '' : ' without-source'}${imagesOpen ? ' images-covered' : ''}`}>
            {source ? <VideoPlayer key={`player-${source.id}`} videoID={state.video.id} source={source} download={download} ref={player} covered={imagesOpen}
              onImagesFailure={message => {
                closeImages(); setImagesError(message)
                imagesReturn.current?.focus({ preventScroll: true })
              }} />
              : <section inert={imagesOpen} className="video-player"><h2>Lecteur</h2><p>Aucune source YouTube exploitable pour le lecteur et la transcription.</p></section>}
            <div className="workspace-note">
              <div className="note-tabs-bar">
                <div className="note-tabs" role="tablist" aria-label="Contenu de la vidéo">
                  {(['note', 'information'] as const).map((value, index) => (
                    <button
                      key={value}
                      ref={element => { tabButtons.current[index] = element }}
                      className="button"
                      role="tab"
                      id={value + '-tab'}
                      aria-controls={value + '-panel'}
                      aria-selected={tab === value}
                      tabIndex={tab === value ? 0 : -1}
                      onClick={() => setTab(value)}
                      onKeyDown={event => {
                        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                        event.preventDefault()
                        const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index
                        setTab(next === 0 ? 'note' : 'information')
                        tabButtons.current[next]?.focus()
                      }}
                    >{value === 'note' ? 'Note' : 'Informations'}</button>
                  ))}
                </div>
                <IconButton icon="images" label="Images" className="images-command"
                  aria-pressed={imagesOpen || imagesBusy} aria-expanded={imagesOpen}
                  aria-controls="images-selector" aria-haspopup="dialog" aria-busy={imagesBusy}
                  onClick={() => void toggleImages()} />
              </div>
              {imagesBusy && <p className="images-opening-message" role="status">Mise en pause de YouTube avant Images…</p>}
              {imagesError && <p className="images-opening-message" role="alert">{imagesError}</p>}
              <Suspense fallback={
                <section id="note-panel" className="note-panel" role="tabpanel"
                  aria-labelledby="note-tab" tabIndex={0} hidden={tab !== 'note'}>
                  <p role="status">Chargement de l’éditeur…</p>
                </section>
              }>
                <VideoNote
                  ref={note}
                  session={noteSession}
                  videoID={state.video.id}
                  visible={tab === 'note'}
                  onReveal={revealNote}
                  onReadingChange={setReadingNote}
                  onRevealImageInsertion={() => flushSync(() => setTab('note'))}
                  imagesOpen={imagesOpen}
                  onNavigate={reference => {
                    if (reference.videoID !== state.video.id) return 'Cette référence concerne une autre vidéo. Aucune navigation effectuée.'
                    if (!source) return 'Navigation non effectuée : aucun lecteur disponible pour cette vidéo.'
                    if (reference.sourceID !== source.id) return 'Cette référence concerne une autre source de cette vidéo. Aucune navigation effectuée.'
                    return navigate(reference.startMs)
                  }}
                  getCaptureTarget={() => {
                    if (!source || !player.current) throw new Error('Temps indisponible : aucun lecteur disponible.')
                    return { videoID: state.video.id, sourceID: source.id, timestampMs: player.current.getCurrentTimeMs() }
                  }}
                  getTimeReference={() => {
                    if (!source || !player.current) throw new Error('Temps indisponible : aucun lecteur disponible.')
                    return temporalReference(state.video.id, source.id, player.current.getCurrentTimeMs())
                  }}
                />
              </Suspense>
              <section
                id="information-panel"
                className="note-panel video-information"
                role="tabpanel"
                aria-labelledby="information-tab"
                tabIndex={0}
                hidden={tab !== 'information'}
              >
                <h2>Titre complet</h2>
                <p className="full-video-title">{title}</p>
                <p className="muted">Ajoutée le <time dateTime={state.video.created_at}>
                  {new Date(state.video.created_at).toLocaleDateString('fr-FR')}
                </time></p>
                {source && <LocalFileDetails download={download} />}
                {state.video.sources.length === 0 && <p>Aucune source disponible.</p>}
                {state.video.sources.map((videoSource, index) => (
                  <SourceDetails
                    key={videoSource.id}
                    source={videoSource}
                    index={index}
                    working={videoSource.id === source?.id}
                  />
                ))}
              </section>
            </div>
            {source && <VideoTranscript covered={imagesOpen} key={source.id} videoID={state.video.id} sourceID={source.id}
              onCite={excerpt => {
                if (!note.current) throw new Error('La note est en cours de chargement. Recommencez la sélection une fois prête.')
                note.current.insertCitation(transcriptCitation(excerpt, state.video.id, source.id))
              }}
              onNavigate={navigate} />}
            {imagesOpen && <Images videoID={state.video.id} sources={state.video.sources}
              narrow={narrow} returnTo={imagesReturn.current} onClose={closeImages}
              session={noteSession} reading={readingNote} onInsert={(asset: Asset) => {
                if (!note.current) throw new Error('La note n’est pas disponible.')
                note.current.insertAsset(asset)
                if (narrow) {
                  flushSync(closeImages)
                  note.current?.focusInsertion()
                }
              }} />}
          </div>
        </>
      )}
    </>
  )
}

/** Réinitialise la fiche au changement d'identité pour ne jamais afficher l'ancienne vidéo. */
export function VideoPage({ titleHost }: { titleHost: HTMLElement | null }) {
  const { videoId = '' } = useParams()
  return <VideoDetail key={videoId} id={videoId} titleHost={titleHost} />
}
