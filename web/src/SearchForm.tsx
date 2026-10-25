import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

/** Sépare la saisie de la requête soumise et remet chaque nouvelle recherche en première page. */
export function SearchForm() {
  const location = useLocation()
  const navigate = useNavigate()
  const submitted = new URLSearchParams(location.search).get('q') ?? ''
  const [draft, setDraft] = useState(submitted)
  useEffect(() => { setDraft(submitted) }, [submitted, location.pathname])
  return <form className="global-search-form" role="search" aria-label="Recherche globale"
    onSubmit={event => {
      event.preventDefault()
      const params = new URLSearchParams({ q: draft })
      if (location.pathname === '/search') {
        // Conserver aussi un tri invalide pour laisser REST signaler l'erreur.
        const sorts = new URLSearchParams(location.search).getAll('sort')
        if (sorts.length !== 1 || sorts[0] !== 'relevance') {
          for (const sort of sorts) params.append('sort', sort)
        }
      }
      navigate('/search?' + params.toString())
    }}>
    <label className="sr-only" htmlFor="global-search">Rechercher dans la bibliothèque</label>
    <input id="global-search" type="search" value={draft} maxLength={1024}
      placeholder="Rechercher dans la bibliothèque…" onChange={event => setDraft(event.target.value)} />
    <button type="submit" aria-label="Lancer la recherche" title="Lancer la recherche">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" />
      </svg>
    </button>
  </form>
}
