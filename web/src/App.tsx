import { useEffect, useRef } from 'react'
import { Link, Route, Routes, useLocation, useMatch } from 'react-router'
import { Library } from './Library'
import { AddVideo } from './AddVideo'
import { VideoPage } from './VideoPage'
import { ThemeSelector } from './ThemeSelector'

/** Assemble les pages sans déplacer l'état des acquisitions dans un store global. */
export function App() {
  const location = useLocation()
  const videoPage = Boolean(useMatch('/videos/:videoId')) && location.pathname !== '/videos/new'
  const main = useRef<HTMLElement>(null)

  useEffect(() => {
    // Une navigation SPA annonce son nouveau contexte aux utilisateurs du clavier.
    main.current?.focus({ preventScroll: true })
    window.scrollTo(0, 0)
  }, [location.pathname])

  return (
    <>
      <a className="skip-link" href="#main">Aller au contenu</a>
      <header className={`site-header${videoPage ? ' site-header-compact' : ''}`}>
        <Link className="brand" to="/" aria-label="Sillage, accueil">
          <span className="brand-mark" aria-hidden="true">≈</span>Sillage
        </Link>
        {!videoPage && <span className="header-caption">Une trace de ce qui compte.</span>}
        <ThemeSelector />
      </header>
      <main id="main" ref={main} tabIndex={-1}>
        <Routes>
          <Route path="/" element={<Library />} />
          <Route path="/videos/new" element={<AddVideo />} />
          <Route path="/videos/:videoId" element={<VideoPage />} />
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
      <footer>Des vidéos aux idées.</footer>
    </>
  )
}
