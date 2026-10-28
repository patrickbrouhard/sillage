import { useEffect, useRef, useState } from 'react'
import { Link, Route, Routes, useLocation, useMatch } from 'react-router'
import { Library } from './Library'
import { AddVideo } from './AddVideo'
import { VideoPage } from './VideoPage'
import { SiteNavigation } from './SiteNavigation'
import { Search } from './Search'
import { SearchForm } from './SearchForm'
import { Tags } from './Tags'

/** Assemble les pages sans déplacer l'état des acquisitions dans un store global. */
export function App() {
  const location = useLocation()
  const videoPage = Boolean(useMatch('/videos/:videoId')) && location.pathname !== '/videos/new'
  const [actionsHost, setActionsHost] = useState<HTMLDivElement | null>(null)
  const [titleHost, setTitleHost] = useState<HTMLDivElement | null>(null)
  const main = useRef<HTMLElement>(null)

  const previousPath = useRef<string | null>(null)
  useEffect(() => {
    // Le focus demandé par le volet attend la navigation autorisée par le garde.
    const focusSearch = location.pathname === '/search' && location.state?.focusSearch
    if (focusSearch) document.getElementById('global-search')?.focus({ preventScroll: true })
    else if (previousPath.current !== location.pathname) main.current?.focus({ preventScroll: true })
    if (previousPath.current !== location.pathname) window.scrollTo(0, 0)
    previousPath.current = location.pathname
  }, [location.pathname, location.key])
  const searchHeader = location.pathname === '/' || location.pathname === '/search'


  return (
    <>
      <a className="skip-link" href="#main">Aller au contenu</a>
      <header className={`site-header${videoPage ? ' site-header-compact' : ' site-header-common' + (searchHeader ? ' site-header-search' : '') + (location.pathname === '/' ? ' site-header-library' : '')}`}>
        <div className="header-navigation">
          <SiteNavigation />
          <Link className="brand" to="/" aria-label="Sillage, accueil">
            <span className="brand-mark" aria-hidden="true">≈</span><span>Sillage</span>
          </Link>
        </div>
        {videoPage && <div className="video-header-content" ref={setTitleHost} />}
        {searchHeader && <SearchForm />}
        {location.pathname === '/' && <div className="library-header-actions" ref={setActionsHost} />}
      </header>
      <main className={location.pathname === '/' ? 'library-main' : undefined} id="main" ref={main} tabIndex={-1} aria-labelledby={videoPage ? 'video-title' : undefined}>
        <Routes>
          <Route path="/" element={<Library actionsHost={actionsHost} />} />
          <Route path="/search" element={<Search />} />
          <Route path="/tags" element={<Tags />} />
          <Route path="/videos/new" element={<AddVideo />} />
          <Route path="/videos/:videoId" element={<VideoPage titleHost={titleHost} />} />
          <Route path="*" element={
            <div className="state-panel">
              <title>Page introuvable · Sillage</title>
              <h1>Page introuvable</h1>
              <p>Cette page n’existe pas.</p>
              <Link className="button" to="/">Revenir à la bibliothèque</Link>
            </div>
          } />
        </Routes>
      </main>
    </>
  )
}
