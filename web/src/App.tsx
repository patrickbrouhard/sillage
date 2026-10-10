import { useEffect, useState } from 'react'
import { listVideos } from './api'
import type { Video } from './api'
import { VideoCard } from './VideoCard'

type LibraryState =
  | { status: 'loading' }
  | { status: 'ready'; videos: Video[] }
  | { status: 'error'; message: string }

/** Charge une vue cohérente et annule sa lecture au démontage ou à la relance. */
function Library() {
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
            message: error instanceof TypeError
              ? 'Le serveur est inaccessible. Vérifiez la connexion puis réessayez.'
              : error instanceof Error ? error.message : 'Une erreur est survenue.',
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
      <div className="page-heading">
        <div>
          <p className="eyebrow">VOTRE BASE DE CONNAISSANCES</p>
          <h1>Bibliothèque</h1>
          <p className="intro">Les vidéos que vous souhaitez garder à portée de pensée.</p>
        </div>
        <button className="button" onClick={refresh} disabled={state.status === 'loading'}>
          Actualiser
        </button>
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

/** Affiche la bibliothèque ; les autres pages seront ajoutées au jalon navigation. */
export function App() {
  const isLibrary = window.location.pathname === '/'
  return (
    <>
      <a className="skip-link" href="#main">Aller au contenu</a>
      <header className="site-header">
        <a className="brand" href="/" aria-label="Sillage, accueil">
          <span className="brand-mark" aria-hidden="true">≈</span>Sillage
        </a>
        <span className="header-caption">Une trace de ce qui compte.</span>
      </header>
      <main id="main">
        {isLibrary ? <Library /> : (
          <div className="state-panel">
            <h1>Page introuvable</h1>
            <p>Cette page n’existe pas.</p>
            <a className="button" href="/">Revenir à la bibliothèque</a>
          </div>
        )}
      </main>
      <footer>Des vidéos aux idées.</footer>
    </>
  )
}
