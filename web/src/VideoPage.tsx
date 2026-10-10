import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { APIError, errorMessage, getVideo } from './api'
import type { Video, VideoSource } from './api'
import { VideoThumbnail } from './VideoThumbnail'
import { formatDuration, httpURL, providerLabel } from './videoPresentation'

type DetailState =
  | { status: 'loading' }
  | { status: 'ready'; video: Video }
  | { status: 'error'; message: string; missing: boolean }

/** Affiche les métadonnées de chaque provenance sans déduire un auteur du publisher. */
function SourceDetails({ source, index }: { source: VideoSource; index: number }) {
  const url = httpURL(source.canonical_url)
  return (
    <section className="source-section" aria-labelledby={`source-${source.id}`}>
      <h2 id={`source-${source.id}`}>Source {index + 1} · {providerLabel(source.provider)}</h2>
      <div className="source-overview">
        <VideoThumbnail source={source} />
        <div>
          <h3>{source.title || 'Titre non renseigné'}</h3>
          <dl className="metadata">
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
      <h3>Description</h3>
      <p className="description">{source.description || 'Aucune description disponible.'}</p>
    </section>
  )
}

/** Relit une fiche par son identité Sillage, sans dépendre de la navigation précédente. */
function VideoDetail({ id }: { id: string }) {
  const [state, setState] = useState<DetailState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

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
      <Link className="back-link" to="/">← Revenir à la bibliothèque</Link>
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
          <p className="eyebrow">FICHE VIDÉO</p>
          <h1 className="video-title">{state.video.sources[0]?.title || 'Vidéo sans titre'}</h1>
          <p className="muted">Ajoutée le <time dateTime={state.video.created_at}>
            {new Date(state.video.created_at).toLocaleDateString('fr-FR')}
          </time></p>
          {state.video.tags.length > 0 ? (
            <ul className="tags detail-tags" aria-label="Tags de la vidéo">
              {state.video.tags.map((tag) => <li key={tag.id}>{tag.name}</li>)}
            </ul>
          ) : <p className="muted">Aucun tag associé à cette vidéo.</p>}
          {state.video.sources.length === 0 && <p>Aucune source disponible.</p>}
          {state.video.sources.map((source, index) => (
            <SourceDetails key={source.id} source={source} index={index} />
          ))}
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
