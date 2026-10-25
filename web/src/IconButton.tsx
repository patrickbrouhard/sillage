import { useId, useState } from 'react'
import type { ButtonHTMLAttributes, Ref } from 'react'

type IconName = 'pencil' | 'book-open' | 'clock-plus' | 'camera' | 'info' | 'eye' | 'eye-off' | 'download' | 'refresh' | 'search' | 'quote' | 'previous' | 'next' | 'clear' | 'trash' | 'save' | 'check' | 'spinner' | 'conflict' | 'menu' | 'tags' | 'images' | 'plus'

/** Dessine les quelques commandes des panneaux sans dépendance ni texte exposé aux lecteurs d'écran. */
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    images: 'M7 3h14v14 M3 7h14v14H3V7 M3 17l4-4 3 3 2-2 5 5 M7 11h.01',
    plus: 'M12 5v14 M5 12h14',
    pencil: 'm16 3 5 5 M4 15 16 3a3.5 3.5 0 0 1 5 5L9 20l-6 1 1-6',
    'book-open': 'M12 7v14 M3 3h3a6 6 0 0 1 6 4 6 6 0 0 1 6-4h3v17h-3a6 6 0 0 0-6 1 6 6 0 0 0-6-1H3V3',
    'clock-plus': 'M12 8v4l2 2 M21 10a9 9 0 1 0-11 11 M18 15v6 M15 18h6',
    camera: 'M14 4h-4L8 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-4l-2-3 M16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    menu: 'M4 6h16 M4 12h16 M4 18h16',
    tags: 'M3 3h8l10 10-8 8L3 11V3 M7 7h.01',
    save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2 M7 3v6h9V3 M7 21v-8h10v8',
    check: 'm5 12 4 4L19 6',
    spinner: 'M21 12a9 9 0 1 1-9-9',
    conflict: 'M12 3 2 21h20L12 3 M12 9v5 M12 17h.01',
    info: 'M12 11v6 M12 7h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    'eye-off': 'm3 3 18 18 M10 5.2A12 12 0 0 1 12 5c6.5 0 10 7 10 7a20 20 0 0 1-3 4 M6 6C3.5 8.2 2 12 2 12s3.5 7 10 7a12 12 0 0 0 5-1 M9.9 9.9a3 3 0 0 0 4.2 4.2',
    download: 'M12 3v12 m-5-5 5 5 5-5 M4 15v5h16v-5',
    refresh: 'M20 7v5h-5 M4 17v-5h5 M5.1 8a8 8 0 0 1 13.2-2L20 8 M4 16l1.7 2A8 8 0 0 0 18.9 16',
    search: 'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0 m-2 4 6 6',
    quote: 'M4 6h6v7H6c0 3-2 5-3 5 M14 6h6v7h-4c0 3-2 5-3 5',
    previous: 'm14 6-6 6 6 6',
    next: 'm10 6 6 6-6 6',
    clear: 'm6 6 12 12 M6 18 18 6',
    trash: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  }
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={paths[name]} />
  </svg>
}

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName
  label: string
  tooltip?: string
  ref?: Ref<HTMLButtonElement>
}

/** Conserve une cible confortable et une aide au survol ou au focus, même pour une action désactivée. */
export function IconButton({ icon, label, tooltip = label, ref, className = '', ...props }: Props) {
  const id = useId()
  const [dismissed, setDismissed] = useState(false)
  // Un clic peut déplacer le focus ou replier un panneau : il ferme l'aide jusqu'au
  // prochain survol ou geste clavier, sans confondre focus souris et focus visible.
  return <span className={`icon-control${dismissed ? ' tooltip-dismissed' : ''}`}
    onMouseEnter={() => setDismissed(false)} onMouseLeave={() => setDismissed(true)}
    onFocus={() => setDismissed(false)} onBlur={() => setDismissed(false)}
    onClick={() => setDismissed(true)}
    onKeyDown={event => setDismissed(event.key === 'Escape')}>
    <button {...props} ref={ref} type="button" className={`button icon-button ${className}`}
      aria-label={label} aria-describedby={id}>
      <Icon name={icon} />
    </button>
    <span id={id} role="tooltip" className="icon-tooltip">{tooltip}</span>
  </span>
}
