import { useLayoutEffect } from 'react'
import type { RefObject } from 'react'
import { Icon } from './IconButton'

/** Ancre deux actions à la plage native, sans déplacer la sélection ni sortir du panneau inert. */
export function TranscriptSelectionToolbar({ range, container, toolbar, onClose, onCite, onSearch }: {
  range: Range
  container: RefObject<HTMLDivElement | null>
  toolbar: RefObject<HTMLDivElement | null>
  onClose: () => void
  onCite: () => void
  onSearch: () => void
}) {
  useLayoutEffect(() => {
    /** Suit les défilements des panneaux et le viewport réduit par le clavier virtuel. */
    function position() {
      const panel = container.current
      const menu = toolbar.current
      if (!panel || !menu || !range.startContainer.isConnected || !range.endContainer.isConnected) {
        onClose()
        return
      }
      const viewport = window.visualViewport
      const left = (viewport?.offsetLeft ?? 0) + 8
      const top = (viewport?.offsetTop ?? 0) + 8
      const right = left + (viewport?.width ?? innerWidth) - 16
      const bottom = top + (viewport?.height ?? innerHeight) - 16
      const panelBox = panel.getBoundingClientRect()
      // Une sélection traversante peut dépasser le panneau ; choisir un fragment encore visible.
      const anchor = Array.from(range.getClientRects()).find(rect =>
        rect.width > 0 && rect.height > 0 &&
        rect.bottom > Math.max(top, panelBox.top) && rect.top < Math.min(bottom, panelBox.bottom) &&
        rect.right > Math.max(left, panelBox.left) && rect.left < Math.min(right, panelBox.right))
      if (!anchor) { onClose(); return }
      menu.style.maxWidth = right - left + 'px'
      menu.style.maxHeight = bottom - top + 'px'
      const box = menu.getBoundingClientRect()
      const x = Math.max(left, Math.min(anchor.left + anchor.width / 2 - box.width / 2, right - box.width))
      // Garder l'en-tête et ses actions dégagés quand le passage commence en haut du panneau.
      const y = anchor.top - box.height - 8 >= Math.max(top, panelBox.top)
        ? anchor.top - box.height - 8 : anchor.bottom + 8
      menu.style.left = x + 'px'
      menu.style.top = Math.max(top, Math.min(y, bottom - box.height)) + 'px'
      menu.style.visibility = 'visible'
    }
    position()
    const observer = new ResizeObserver(position)
    if (container.current) observer.observe(container.current)
    window.addEventListener('scroll', position, true)
    window.addEventListener('resize', position)
    window.visualViewport?.addEventListener('scroll', position)
    window.visualViewport?.addEventListener('resize', position)
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', position, true)
      window.removeEventListener('resize', position)
      window.visualViewport?.removeEventListener('scroll', position)
      window.visualViewport?.removeEventListener('resize', position)
    }
  }, [range, container, toolbar, onClose])

  return <div ref={toolbar} className="transcript-selection-actions" role="toolbar"
    aria-label="Actions de la sélection de transcription" style={{ visibility: 'hidden' }}
    onPointerDown={event => {
      // Le pointeur active les boutons sans effondrer la plage ; le clavier garde son focus natif.
      if (event.button === 0) event.preventDefault()
    }}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      const buttons = Array.from(event.currentTarget.querySelectorAll('button'))
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
      event.preventDefault()
      buttons[next]?.focus({ preventScroll: true })
    }}>
    <button type="button" className="icon-button" aria-label="Citer dans la note"
      title="Citer dans la note" onClick={onCite}><Icon name="quote" /></button>
    <button type="button" className="icon-button" aria-label="Rechercher dans la transcription"
      title="Rechercher dans la transcription" onClick={onSearch}><Icon name="search" /></button>
  </div>
}
