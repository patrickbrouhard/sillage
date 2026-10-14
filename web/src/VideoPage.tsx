import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { APIError, errorMessage, getVideo } from './api'
import type { Tag, Video, VideoSource } from './api'
import { VideoTags } from './VideoTags'
import { VideoThumbnail } from './VideoThumbnail'
import { VideoTranscript } from './VideoTranscript'
import { YouTubePlayer } from './YouTubePlayer'
import type { YouTubePlayerHandle } from './YouTubePlayer'
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
function VideoDetail({ id }: { id: string }) {
  const note = useRef<VideoNoteHandle>(null)
  const player = useRef<YouTubePlayerHandle>(null)
  const [state, setState] = useState<DetailState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const location = useLocation()
  const source = state.status === 'ready' ? workSource(state.video.sources) : undefined
  const origin: unknown = location.state?.library
  // Seul le contexte interne de bibliothèque peut devenir la destination de retour.
  const backTo = typeof origin === 'string' && /^\/\?tag_id=[0-9]+$/.test(origin) ? origin : '/'
  /** Point d'entrée commun : le lecteur décide de la disponibilité et du défilement. */
  function navigate(startMs: number): string {
    return player.current?.navigate(startMs) ?? 'Navigation non effectuée : lecteur indisponible.'
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
      <title>{`${state.status === 'ready' ? state.video.sources[0]?.title || 'Vidéo' : 'Fiche vidéo'} · Sillage`}</title>
      <Link className="back-link" to={backTo}>← Revenir à la bibliothèque</Link>
      {state.status === 'loading' && <div className="state-panel" role="status">Chargement de la vidéo…</div>}
      {state.status === 'error' && (
        <div className="state-panel error" role="alert">
          <h1>{state.missing ? 'Vidéo introuvable' : 'Impossible d’ouvrir cette vidéo'}</h1>
          <p>{state.message}</p>
          {!state.missing && <button className="button" onClick={() => {
            setState({ status: 'loading' })
            setAttempt((value) => value + 1)
          }}>Réessayer</button>}
        </div>
      )}
      {state.status === 'ready' && (
        <>
          <h1 className="video-title">{state.video.sources[0]?.title || 'Vidéo sans titre'}</h1>
          <VideoTags videoID={state.video.id} tags={state.video.tags} onChange={updateTags} />
          <div className={`video-workspace${source ? '' : ' without-source'}`}>
            {source ? <YouTubePlayer key={`player-${source.id}`} source={source} ref={player} />
              : <section className="video-player"><h2>Lecteur</h2><p>Aucune source YouTube exploitable pour le lecteur et la transcription.</p></section>}
            <div className="workspace-note">
              <Suspense fallback={<p role="status">Chargement de l’éditeur…</p>}><VideoNote ref={note} videoID={state.video.id}
                onNavigate={reference => {
                  if (reference.videoID !== state.video.id) return 'Cette référence concerne une autre vidéo. Aucune navigation effectuée.'
                  if (!source) return 'Navigation non effectuée : aucun lecteur disponible pour cette vidéo.'
                  if (reference.sourceID !== source.id) return 'Cette référence concerne une autre source de cette vidéo. Aucune navigation effectuée.'
                  return navigate(reference.startMs)
                }}
                getTimeReference={() => {
                  if (!source || !player.current) throw new Error('Temps indisponible : aucun lecteur YouTube disponible.')
                  return temporalReference(state.video.id, source.id, player.current.getCurrentTimeMs())
                }} /></Suspense>
            </div>
            {source && <VideoTranscript key={source.id} videoID={state.video.id} sourceID={source.id}
              onCite={excerpt => {
                if (!note.current) throw new Error('La note est en cours de chargement. Recommencez la sélection une fois prête.')
                note.current.insertCitation(transcriptCitation(excerpt, state.video.id, source.id))
              }}
              onNavigate={navigate} />}
          </div>
          <details className="video-metadata">
            <summary>Métadonnées et sources</summary>
            <p className="muted">Ajoutée le <time dateTime={state.video.created_at}>
              {new Date(state.video.created_at).toLocaleDateString('fr-FR')}
            </time></p>
            {state.video.sources.length === 0 && <p>Aucune source disponible.</p>}
            {state.video.sources.map((videoSource, index) => (
              <SourceDetails
                key={videoSource.id}
                source={videoSource}
                index={index}
                working={videoSource.id === source?.id}
              />
            ))}
          </details>
        </>
      )}
    </>
  )
}

/** Réinitialise la fiche au changement d'identité pour ne jamais afficher l'ancienne vidéo. */
export function VideoPage() {
  const { videoId = '' } = useParams()
  return <VideoDetail key={videoId} id={videoId} />
}
