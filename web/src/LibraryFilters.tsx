import { useLayoutEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/** Présente les critères de la bibliothèque sans dupliquer leur état dans le panneau. */
export function LibraryFilters({ active, children }: { active: boolean; children: ReactNode }) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  /** Ancre le panneau au bouton et borne sa surface au viewport disponible. */
  function position() {
    if (!trigger.current || !panel.current) return
    const rect = trigger.current.getBoundingClientRect()
    const width = Math.min(340, document.documentElement.clientWidth - 32)
    panel.current.style.width = width + 'px'
    panel.current.style.left = Math.max(16, Math.min(rect.right - width, document.documentElement.clientWidth - width - 16)) + 'px'
    panel.current.style.top = Math.max(8, Math.min(rect.bottom + 8, innerHeight - 80)) + 'px'
    panel.current.style.maxHeight = Math.max(60, innerHeight - Math.max(8, rect.bottom + 8) - 16) + 'px'
  }

  useLayoutEffect(() => {
    if (!open) return
    // Un défilement extérieur ferme la couche avant qu'elle ne quitte son ancrage.
    const closeOnScroll = (event: Event) => {
      if (event.target instanceof Node && panel.current?.contains(event.target)) return
      const focused = panel.current?.contains(document.activeElement)
      panel.current?.hidePopover()
      if (focused) trigger.current?.focus({ preventScroll: true })
    }
    window.addEventListener('resize', position)
    window.addEventListener('scroll', closeOnScroll, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', closeOnScroll, true)
    }
  }, [open])

  return <>
    <button ref={trigger} className="button library-filter-trigger" popoverTarget={id}
      aria-expanded={open} aria-controls={id} onClick={position}>
      Filtres{active && <span className="filter-count">1</span>}
    </button>
    <div ref={panel} id={id} popover="auto" className="library-filter" role="region"
      aria-label="Filtrage de la bibliothèque"
      onToggle={event => {
        const visible = event.newState === 'open'
        setOpen(visible)
        if (visible) {
          position()
          panel.current?.querySelector('select')?.focus({ preventScroll: true })
        }
      }}>
      {children}
    </div>
  </>
}
