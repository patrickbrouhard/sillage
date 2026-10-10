import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { errorMessage, listVideos } from './api'
import type { Video } from './api'
import { useTagCatalog } from './useTagCatalog'
import { VideoCard } from './VideoCard'

type LibraryState =
  | { status: 'loading' }
  | { status: 'ready'; videos: Video[] }
  | { status: 'error'; message: string }

/** Charge une vue cohérente et annule sa lecture au démontage ou à la relance. */
export function Library() {
  const [params, setParams] = useSearchParams()
  const values = params.getAll('tag_id')
  const tagID = values[0]
  const repeated = values.length > 1
  const filterKey = JSON.stringify(values)
  const catalog = useTagCatalog()
  const [result, setResult] = useState<{ key: string; state: LibraryState }>({
    key: filterKey, state: { status: 'loading' },
  })
  const state: LibraryState = result.key === filterKey ? result.state : { status: 'loading' }
  function setState(state: LibraryState) { setResult({ key: filterKey, state }) }
  const activeTag = catalog.tags.find((tag) => String(tag.id) === tagID)
  const filterLabel = activeTag?.name ?? `Tag n° ${tagID}`
  function selectTag(value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set('tag_id', value)
    else next.delete('tag_id')
    setParams(next)
  }
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (repeated) {
      setState({ status: 'error', message: 'Un seul filtre de tag est autorisé. Retirez le filtre pour continuer.' })
      return
    }
    setState({ status: 'loading' })
    const controller = new AbortController()
    // Le garde protège aussi la phase de décodage après une annulation.
    void listVideos(controller.signal, tagID).then(
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
  }, [attempt, filterKey])

  function refresh() {
    setState({ status: 'loading' })
    setAttempt((value) => value + 1)
    catalog.refresh()
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
      <section className="library-filter" aria-label="Filtrage de la bibliothèque">
        <label htmlFor="tag-filter">Filtrer par tag</label>
        <select id="tag-filter" value={tagID ?? ''} onChange={(event) => selectTag(event.target.value)}>
          <option value="">Tous les tags</option>
          {tagID !== undefined && !activeTag && <option value={tagID}>{filterLabel}</option>}
          {[...catalog.tags].sort((a, b) => a.name.localeCompare(b.name, 'fr')).map((tag) =>
            <option key={tag.id} value={tag.id}>{tag.name}</option>)}
        </select>
        {tagID !== undefined && <div className="active-filter">
          <span>Filtre actif : <strong>{filterLabel}</strong></span>
          <button className="button" onClick={() => selectTag('')}>Retirer le filtre</button>
        </div>}
        {catalog.loading && <p className="muted">Chargement des tags…</p>}
        {catalog.error && <div role="alert" className="notice error">
          <p>{catalog.error} La liste des vidéos reste indépendante du catalogue.</p>
          <button className="button" onClick={catalog.refresh}>Réessayer les tags</button>
        </div>}
        {!catalog.loading && !catalog.error && catalog.tags.length === 0 &&
          <p className="muted">Aucun tag dans le catalogue pour le moment.</p>}
      </section>
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
              <h2>{tagID === undefined ? 'Votre bibliothèque est encore vide' : 'Aucune vidéo pour ce tag'}</h2>
              <p>{tagID === undefined
                ? 'Les vidéos enregistrées dans Sillage apparaîtront ici.'
                : 'Aucune vidéo n’est directement associée à ce filtre. Retirez-le pour voir toute la bibliothèque.'}</p>
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

