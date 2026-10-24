import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { errorMessage } from './api'
import { searchVideos } from './searchApi'
import type { SearchPage, SearchResult } from './searchApi'
import { VideoThumbnail } from './VideoThumbnail'
import { SearchExcerpt } from './SearchExcerpt'

type State = { status: 'loading' } | { status: 'ready'; page: SearchPage } | { status: 'error'; message: string }

/** Explique chaque source contributrice sans attribuer artificiellement la requête entière à l'une d'elles. */
function SearchRow({ result }: { result: SearchResult }) {
  const { video, note_excerpt, source_matches } = result
  const source = video.sources[0]
  const title = source?.title || 'Vidéo sans titre'
  return <article className="search-result">
    <Link className="search-thumbnail" to={'/videos/' + video.id} aria-label={'Consulter : ' + title} tabIndex={-1}>
      <VideoThumbnail source={source} />
    </Link>
    <div className="search-result-content">
      <h2><Link to={'/videos/' + video.id}>{title}</Link></h2>
      <p className="publisher">{source?.publisher?.name || 'Compte de publication non renseigné'}</p>
      {video.tags.length > 0 && <ul className="tags" aria-label="Tags">
        {video.tags.map(tag => <li key={tag.id}>
          <Link to={'/?tag_id=' + tag.id}>{tag.name}</Link>
        </li>)}
      </ul>}
      {source_matches.map(match => {
        const matched = video.sources.find(item => item.id === match.source_id)
        const secondary = match.source_id !== source?.id
        if (!secondary && !match.description && !match.publisher) return null
        const fields = [match.title && 'titre', match.description && 'description', match.publisher && 'publisher'].filter(Boolean).join(', ')
        return <p key={match.source_id} className="search-explanation">
          {secondary ? 'Autre source : ' + (matched?.title || 'Sans titre') + ' — ' : 'Correspondance : '}
          {fields}{match.publisher && matched?.publisher?.name ? ' (' + matched.publisher.name + ')' : ''}
        </p>
      })}
      {note_excerpt.length > 0 && <SearchExcerpt key={JSON.stringify(note_excerpt)} segments={note_excerpt} />}
    </div>
  </article>
}

/** Charge une requête URL soumise et protège la page contre les réponses obsolètes. */
export function Search() {
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  const query = params.get('q') ?? ''
  const invitation = !query.trim() && params.getAll('q').length <= 1 && !params.has('page')
  // Une soumission identique crée une nouvelle navigation et doit relire la bibliothèque.
  const key = location.key
  const search = location.search
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ key: string; state: State }>({ key, state: { status: 'loading' } })
  const state: State = result.key === key ? result.state : { status: 'loading' }
  useEffect(() => {
    if (invitation) return
    const controller = new AbortController()
    setResult({ key, state: { status: 'loading' } })
    void searchVideos(search.replace(/^\?/, ''), controller.signal).then(page => {
      if (!controller.signal.aborted) setResult({ key, state: { status: 'ready', page } })
    }, error => {
      if (!controller.signal.aborted) setResult({ key, state: { status: 'error', message: errorMessage(error) } })
    })
    return () => controller.abort()
  }, [key, search, attempt, invitation])
  function pageURL(page: number): string {
    const next = new URLSearchParams(location.search)
    next.set('page', String(page))
    return '/search?' + next.toString()
  }
  return <>
    <title>Recherche · Sillage</title>
    <h1 className="sr-only search-page-title">{invitation ? 'Recherche' : 'Résultats pour « ' + query + ' »'}</h1>
    {invitation ? <div className="state-panel">
      <h2>Que souhaitez-vous retrouver ?</h2>
      <p>Recherchez dans les titres, tags, notes, descriptions et publishers de votre bibliothèque.</p>
    </div> : state.status === 'loading' ? <div className="state-panel" role="status">Recherche en cours…</div>
      : state.status === 'error' ? <div className="state-panel error" role="alert">
        <p>{state.message}</p><button className="button" onClick={() => setAttempt(value => value + 1)}>Réessayer</button>
      </div> : <>
        <p role="status" className="search-count">
          {state.page.total} vidéo{state.page.total > 1 ? 's' : ''} correspondante{state.page.total > 1 ? 's' : ''}
        </p>
        {state.page.results.length === 0 ? <div className="state-panel"><h2>{state.page.total === 0 ? 'Aucun résultat' : 'Aucun résultat sur cette page'}</h2>
          <p>{state.page.total === 0 ? 'Essayez d’autres termes ou une recherche plus courte.'
            : 'Des vidéos correspondent à votre recherche. Revenez aux pages précédentes.'}</p></div>
          : <div className="search-results">{state.page.results.map(result => <SearchRow key={key + ':' + result.video.id} result={result} />)}</div>}
        <nav className="search-pagination" aria-label="Pages de recherche">
          {state.page.page > 1 && <Link className="button" to={pageURL(state.page.page - 1)}>Page précédente</Link>}
          <span>Page {state.page.page}</span>
          {state.page.has_more && state.page.page < 1000 && <Link className="button" to={pageURL(state.page.page + 1)}>Page suivante</Link>}
        </nav>
      </>}
  </>
}
