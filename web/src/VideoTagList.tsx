import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import type { Tag } from './api'
import { measureHeaderLayout } from './videoHeaderLayout'

/** Affiche un préfixe stable des tags selon leur largeur réelle, sans requête ni classement local. */
export function VideoTagList({ title, tags, onRestoreFocus }: { title: string; tags: Tag[]; onRestoreFocus: () => void }) {
  const id = useId()
  const container = useRef<HTMLDivElement>(null)
  const measurements = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const count = useRef(0)
  const restoreFocus = useRef(false)
  const [visibleCount, setVisibleCount] = useState(0)
  const [open, setOpen] = useState(false)
  const visible = Math.min(visibleCount, tags.length)
  const remaining = tags.length - visible

  /** Positionne la couche native sans la laisser sortir du viewport ni dépendre du contenu du titre. */
  function positionPopover() {
    const button = trigger.current
    const panel = popover.current
    if (!button || !panel) return
    const rect = button.getBoundingClientRect()
    const width = Math.min(320, document.documentElement.clientWidth - 32)
    panel.style.width = width + 'px'
    panel.style.left = Math.max(16, Math.min(rect.right - width, document.documentElement.clientWidth - width - 16)) + 'px'
    panel.style.top = rect.bottom + 8 + 'px'
    panel.style.maxHeight = Math.max(60, Math.min(innerHeight * .5, innerHeight - rect.bottom - 24)) + 'px'
  }

  useLayoutEffect(() => {
    const box = container.current!
    const group = box.parentElement!
    const management = box.nextElementSibling!
    const measureBox = measurements.current!
    const panel = popover.current!
    const header = group.closest<HTMLElement>('.site-header')!
    const host = group.parentElement!
    const navigation = header.querySelector<HTMLElement>('.header-navigation')!
    const titleMeasure = host.querySelector<HTMLElement>('.header-title-measure')!
    // Une nouvelle liste rend la consultation ouverte périmée, même si sa longueur reste identique.
    if (panel.matches(':popover-open')) {
      restoreFocus.current = panel.contains(document.activeElement)
      panel.hidePopover()
    }
    const measure = () => {
      const widths = [...measureBox.querySelectorAll<HTMLElement>('[data-tag-width]')].map(el => el.getBoundingClientRect().width)
      const counters = [...measureBox.querySelectorAll<HTMLElement>('[data-counter-width]')].map(el => el.getBoundingClientRect().width)
      const gap = Number.parseFloat(getComputedStyle(box).columnGap) || 0
      const total = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * gap
      // Un tag très court peut être moins large que +1 : ne pas tronquer le titre
      // pour réserver un compteur dont l'affichage intégral permet de se passer.
      const minimumTags = Math.min(total, counters.at(-1) ?? 0)
      // Mesurer le groupe alloué, pas la liste ajustée à son contenu : le bouton
      // peut suivre les tags sans créer une boucle entre budget et préfixe visible.
      const desktop = matchMedia('(min-width: 1100px)').matches
      const layout = desktop ? measureHeaderLayout(
        header,
        navigation,
        titleMeasure,
        management,
        minimumTags,
        widths.length > 0,
      ) : null
      const available = layout?.tagBudget ?? (group.getBoundingClientRect().width
        - management.getBoundingClientRect().width
        - (Number.parseFloat(getComputedStyle(group).columnGap) || 0))
      let next = widths.length
      if (total > available) {
        next = 0
        let prefix = 0
        // Tester le compteur réel de chaque candidat évite les oscillations autour de +9/+10.
        for (let i = 0; i < widths.length; i++) {
          if (i > 0) prefix += widths[i - 1] + (i > 1 ? gap : 0)
          const needed = prefix + (i > 0 ? gap : 0) + counters[widths.length - i - 1]
          if (needed <= available) next = i
        }
      }
      // Le placement dépend du résultat, mais ne modifie jamais le budget du calcul.
      const prefixWidth = widths.slice(0, next).reduce((sum, width) => sum + width, 0)
        + Math.max(0, next - 1) * gap
      const used = next === widths.length ? prefixWidth
        : prefixWidth + (next > 0 ? gap : 0) + counters[widths.length - next - 1]
      if (layout) {
        header.style.setProperty('--navigation-width', layout.navigationWidth + 'px')
        host.style.setProperty('--title-width', layout.titleWidth + 'px')
        host.style.setProperty('--group-width', layout.groupWidth(used) + 'px')
        host.dataset.centered = String(layout.groupWidth(used) <= layout.centerBudget)
      } else {
        host.style.removeProperty('--title-width')
        host.style.removeProperty('--group-width')
        delete host.dataset.centered
      }
      if (next === count.current) {
        // Le groupe peut changer de placement sans changer de préfixe.
        if (panel.matches(':popover-open')) positionPopover()
        return
      }
      const focusedIndex = [...(list.current?.querySelectorAll('a') ?? [])].findIndex(el => el === document.activeElement)
      restoreFocus.current ||= focusedIndex >= next && focusedIndex >= 0
      if (panel.matches(':popover-open')) {
        restoreFocus.current ||= panel.contains(document.activeElement)
        panel.hidePopover()
      }
      count.current = next
      setVisibleCount(next)
    }
    measure()
    // Les tailles cachées restent indépendantes du nombre retenu : aucune boucle de layout.
    const observer = new ResizeObserver(measure)
    observer.observe(header)
    observer.observe(navigation)
    observer.observe(titleMeasure)
    observer.observe(group)
    observer.observe(management)
    for (const child of measureBox.children) observer.observe(child)
    return () => {
      observer.disconnect()
      header.style.removeProperty('--navigation-width')
      host.style.removeProperty('--title-width')
      host.style.removeProperty('--group-width')
      delete host.dataset.centered
    }
  }, [tags, title])

  useLayoutEffect(() => {
    if (!restoreFocus.current) return
    restoreFocus.current = false
    if (remaining > 0) trigger.current?.focus({ preventScroll: true })
    else {
      const first = list.current?.querySelector('a')
      if (first) first.focus({ preventScroll: true })
      else onRestoreFocus()
    }
  }, [visibleCount, tags, remaining, onRestoreFocus])

  useLayoutEffect(() => {
    if (!open) return
    const closeOnScroll = (event: Event) => {
      if (event.target instanceof Node && popover.current?.contains(event.target)) return
      const focused = popover.current?.contains(document.activeElement)
      popover.current?.hidePopover()
      if (focused) trigger.current?.focus({ preventScroll: true })
    }
    window.addEventListener('resize', positionPopover)
    window.addEventListener('scroll', closeOnScroll, true)
    return () => {
      window.removeEventListener('resize', positionPopover)
      window.removeEventListener('scroll', closeOnScroll, true)
    }
  }, [open])

  return <div className="video-tag-list" ref={container}>
    <ul className="tags detail-tags" aria-label="Tags de la vidéo" ref={list}>
      {tags.slice(0, visible).map(tag => <li key={tag.id}>
        <Link className="tag-pill" to={'/?tag_id=' + tag.id}>{tag.name}</Link>
      </li>)}
    </ul>
    <button ref={trigger} className="button tag-overflow-button" hidden={remaining === 0}
      aria-label={remaining === 1 ? 'Afficher le dernier tag' : 'Afficher les ' + remaining + ' autres tags'} aria-expanded={open} aria-controls={id}
      popoverTarget={id} onClick={positionPopover}>+{remaining}</button>
    <div id={id} ref={popover} className="tag-overflow-popover" popover="auto"
      aria-label="Autres tags de la vidéo" role="region"
      onToggle={event => setOpen(event.newState === 'open')}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          popover.current?.hidePopover()
          trigger.current?.focus({ preventScroll: true })
        }
      }}>
      <p>Autres tags</p>
      <ul>
        {tags.slice(visible).map(tag => <li key={tag.id}>
          <Link to={'/?tag_id=' + tag.id} onClick={() => popover.current?.hidePopover()}>{tag.name}</Link>
        </li>)}
      </ul>
    </div>
    {/* Copies de mesure sans liens ni identifiants, contenues pour ne pas créer de débordement invisible. */}
    <div className="tag-measurements" ref={measurements} aria-hidden="true" inert>
      {tags.map(tag => <span key={tag.id} className="tag-pill" data-tag-width>{tag.name}</span>)}
      {tags.map((tag, index) => <span key={'count-' + tag.id} className="button tag-overflow-button" data-counter-width>+{index + 1}</span>)}
    </div>
  </div>
}
