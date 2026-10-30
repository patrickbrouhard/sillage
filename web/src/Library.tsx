import { DeletionNotice } from './DeletionNotice'
import { createPortal } from 'react-dom'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { errorMessage, listVideos } from './api'
import type { Video } from './api'
import { useTagCatalog } from './useTagCatalog'
import { VideoCard } from './VideoCard'
import { LibraryFilters } from './LibraryFilters'
import { LibraryTagFilter } from './LibraryTagFilter'

type LibraryState =
  | { status: 'loading' }
  | { status: 'ready'; videos: Video[] }
  | { status: 'error'; message: string }

/** Charge une vue cohérente et annule sa lecture au démontage ou à la relance. */
export function Library({ actionsHost }: { actionsHost: HTMLDivElement | null }) {
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
      <DeletionNotice />
      <title>Bibliothèque · Sillage</title>
      <h1 className="sr-only">Bibliothèque</h1>
      {actionsHost && createPortal(<>
        <LibraryFilters active={tagID !== undefined}>
          <LibraryTagFilter tags={catalog.tags} onSelect={selectTag} />
          {tagID !== undefined && <button className="button" onClick={event => {
            // La commande disparaît après le retrait : garder le clavier dans le panneau.
            event.currentTarget.closest('.library-filter')?.querySelector('input')?.focus()
            selectTag('')
          }}>Réinitialiser</button>}
          {catalog.loading && <p className="muted">Chargement des tags…</p>}
          {catalog.error && <div role="alert" className="notice error">
            <p>{catalog.error} La liste des vidéos reste indépendante du catalogue.</p>
            <button className="button" onClick={catalog.refresh}>Réessayer les tags</button>
          </div>}
          {!catalog.loading && !catalog.error && catalog.tags.length === 0 &&
            <p className="muted">Aucun tag dans le catalogue pour le moment.</p>}
        </LibraryFilters>
        <Link className="button primary library-add" to="/videos/new" aria-label="Ajouter une vidéo">
          <span className="library-add-label">Ajouter une vidéo</span><span className="library-add-symbol" aria-hidden="true">+</span>
        </Link>
      </>, actionsHost)}
      <div className="library-summary">
        {state.status === 'ready' && <p className="library-count" role="status">
          {state.videos.length} vidéo{state.videos.length > 1 ? 's' : ''}
        </p>}
        {tagID !== undefined && <div className="active-filter">
          <span>Tag : <strong>{filterLabel}</strong></span>
          <button type="button" aria-label={`Retirer le filtre de tag : ${filterLabel}`} onClick={() => {
            // Le filtre retiré n'a plus de commande ; revenir au point d'entrée du filtrage.
            actionsHost?.querySelector<HTMLButtonElement>('.library-filter-trigger')?.focus({ preventScroll: true })
            selectTag('')
          }}>
            <span aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                <path d="m6 6 12 12 M6 18 18 6" />
              </svg>
            </span>
          </button>
        </div>}
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

