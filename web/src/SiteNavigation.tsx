import { useLayoutEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { IconButton } from './IconButton'
import { ThemeSelector } from './ThemeSelector'
import { SessionMenu } from './AuthGate'

/** Navigation globale superposée ; aucune session métier ne dépend de son ouverture. */
export function SiteNavigation() {
  const location = useLocation()
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  function close() {
    dialog.current?.close()
    setOpen(false)
  }

  useLayoutEffect(() => {
    // Fermer avant le focus de la page suivante ; ne jamais mémoriser un volet ouvert.
    dialog.current?.close()
    setOpen(false)
  }, [location.key])

  return <>
    <IconButton ref={trigger} icon="menu" label="Ouvrir la navigation" className="navigation-trigger"
      aria-expanded={open} aria-controls="site-navigation" aria-haspopup="dialog"
      onClick={() => {
        // Le panneau non modal doit disparaître avant l'ouverture du volet modal.
        document.querySelectorAll<HTMLElement>('.library-filter:popover-open').forEach(panel => panel.hidePopover())
        dialog.current?.showModal()
        setOpen(true)
      }} />
    <dialog id="site-navigation" ref={dialog} className="site-navigation" aria-labelledby="navigation-title"
      onClose={() => setOpen(false)}
      onCancel={event => { event.preventDefault(); close(); trigger.current?.focus({ preventScroll: true }) }}
      onClick={event => {
        if (event.target !== event.currentTarget) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close()
      }}
      onKeyDown={event => {
        if (event.key !== 'Tab') return
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button, a[href], select, summary')].filter(element => element.getClientRects().length > 0)
        const first = controls[0]
        const last = controls.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }}>
      <div className="navigation-heading">
        <h2 id="navigation-title">Navigation</h2>
        <IconButton icon="clear" label="Fermer la navigation" autoFocus onClick={close} />
      </div>
      <nav aria-label="Navigation principale">
        {/* Fermer synchroniquement avant que React Router ne déclenche le garde de la note. */}
        <Link to="/" aria-current={location.pathname === '/' ? 'page' : undefined} onClick={close}>Bibliothèque</Link>
        <Link to="/search" state={{ focusSearch: true }} aria-current={location.pathname === '/search' ? 'page' : undefined} onClick={close}>Rechercher</Link>
        <Link to="/tags" aria-current={location.pathname === '/tags' ? 'page' : undefined} onClick={close}>Tags</Link>
        <Link to="/videos/new" aria-current={location.pathname === '/videos/new' ? 'page' : undefined} onClick={close}>Ajouter une vidéo</Link>
      </nav>
      <SessionMenu />
      <ThemeSelector />
    </dialog>
  </>
}
