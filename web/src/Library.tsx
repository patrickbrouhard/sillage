import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { errorMessage, listVideos } from './api'
import type { Video } from './api'
import { VideoCard } from './VideoCard'

type LibraryState =
  | { status: 'loading' }
  | { status: 'ready'; videos: Video[] }
  | { status: 'error'; message: string }

/** Charge une vue cohérente et annule sa lecture au démontage ou à la relance. */
export function Library() {
  const [state, setState] = useState<LibraryState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    // Le garde protège aussi la phase de décodage après une annulation.
    void listVideos(controller.signal).then(
      (videos) => {
        if (!controller.signal.aborted) setState({ status: 'ready', videos })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            status: 'error',
            message: errorMessage(error),
          })
        }
      },
    )
    return () => controller.abort()
  }, [attempt])

  function refresh() {
    setState({ status: 'loading' })
    setAttempt((value) => value + 1)
  }

  return (
    <>
      <title>Bibliothèque · Sillage</title>
      <div className="page-heading">
        <div>
          <p className="eyebrow">VOTRE BASE DE CONNAISSANCES</p>
          <h1>Bibliothèque</h1>
          <p className="intro">Les vidéos que vous souhaitez garder à portée de pensée.</p>
        </div>
        <div className="page-actions">
          <Link className="button primary" to="/videos/new">Ajouter une vidéo</Link>
          <button className="button" onClick={refresh} disabled={state.status === 'loading'}>
            Actualiser
          </button>
        </div>
      </div>
      {state.status === 'loading' && (
        <div className="state-panel" role="status">Chargement de la bibliothèque…</div>
      )}
      {state.status === 'error' && (
        <div className="state-panel error" role="alert">
          <h2>La bibliothèque n’a pas pu être chargée</h2>
          <p>{state.message}</p>
          <button className="button" onClick={refresh}>Réessayer</button>
        </div>
      )}
      {state.status === 'ready' && (
        <>
          <p className="library-count" role="status">
            {state.videos.length} vidéo{state.videos.length > 1 ? 's' : ''}
          </p>
          {state.videos.length === 0 ? (
            <div className="state-panel">
              <h2>Votre bibliothèque est encore vide</h2>
              <p>Les vidéos enregistrées dans Sillage apparaîtront ici.</p>
            </div>
          ) : (
            <div className="video-grid">
              {state.videos.map((video) => <VideoCard key={video.id} video={video} />)}
            </div>
          )}
        </>
      )}
    </>
  )
}

