import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/** Rend les explications consultables au survol, au clavier et au toucher dans une couche native. */
export function SearchInfo({ children }: { children: ReactNode }) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const pinned = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [open, setOpen] = useState(false)

  function cancelClose() {
    clearTimeout(timer.current)
  }

  /** Laisse traverser l'espace entre bouton et panneau sans refermer une consultation activée. */
  function scheduleClose() {
    cancelClose()
    timer.current = setTimeout(() => {
      if (!pinned.current && document.activeElement !== trigger.current && !panel.current?.contains(document.activeElement)) {
        panel.current?.hidePopover()
      }
    }, 150)
  }

  /** Borne la couche au viewport et choisit le côté disposant du plus de place. */
  function position() {
    const button = trigger.current
    const popover = panel.current
    if (!button || !popover) return
    const rect = button.getBoundingClientRect()
    // Les coordonnées du déclencheur incluent le zoom CSS, contrairement aux styles de la couche.
    const scale = popover.getBoundingClientRect().width / popover.offsetWidth || 1
    const width = Math.min(360, (document.documentElement.clientWidth - 32) / scale)
    popover.style.width = width + 'px'
    const below = innerHeight - rect.bottom - 12
    const above = rect.top - 12
    const down = below >= Math.min(popover.scrollHeight * scale, 240 * scale) || below >= above
    popover.style.maxHeight = Math.max(40, down ? below : above) / scale + 'px'
    popover.style.left = Math.max(16, Math.min(rect.left, document.documentElement.clientWidth - width * scale - 16)) / scale + 'px'
    const top = down ? rect.bottom + 4 : Math.max(8, rect.top - popover.getBoundingClientRect().height - 4)
    popover.style.top = top / scale + 'px'
  }

  useEffect(() => () => clearTimeout(timer.current), [])
  useLayoutEffect(() => {
    if (!open) return
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
    <button ref={trigger} type="button" className="search-info" popoverTarget={id}
      aria-label="Pourquoi cette vidéo apparaît" aria-expanded={open} aria-controls={id}
      aria-describedby={open ? id : undefined}
      onPointerEnter={event => {
        if (event.pointerType !== 'mouse') return
        cancelClose()
        panel.current?.showPopover()
        position()
      }}
      onPointerLeave={scheduleClose}
      onClick={event => {
        cancelClose()
        // Un clic après survol fixe la consultation au lieu de refermer la couche déjà ouverte.
        if (!pinned.current && panel.current?.matches(':popover-open')) event.preventDefault()
        pinned.current = !pinned.current
        position()
      }}
      onBlur={event => {
        if (!pinned.current && !(event.relatedTarget instanceof Node && panel.current?.contains(event.relatedTarget))) {
          panel.current?.hidePopover()
        }
      }}>
      <span aria-hidden="true">ⓘ</span>
    </button>
    <div ref={panel} id={id} className="search-info-popover" popover="auto" role="region"
      aria-label="Explications de la recherche" tabIndex={0}
      onPointerEnter={cancelClose} onPointerLeave={scheduleClose}
      onToggle={event => {
        const visible = event.newState === 'open'
        setOpen(visible)
        if (visible) position()
        else { pinned.current = false; cancelClose() }
      }}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          panel.current?.hidePopover()
          trigger.current?.focus({ preventScroll: true })
        }
      }}>
      {children}
    </div>
  </>
}
