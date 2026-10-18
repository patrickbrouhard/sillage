import { useId, useState } from 'react'
import type { ButtonHTMLAttributes, Ref } from 'react'

type IconName = 'eye' | 'eye-off' | 'download' | 'refresh' | 'search' | 'quote' | 'previous' | 'next' | 'clear' | 'trash'

/** Dessine les quelques commandes des panneaux sans dépendance ni texte exposé aux lecteurs d'écran. */
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
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
  return <span className={`icon-control${dismissed ? ' tooltip-dismissed' : ''}`}
    onMouseLeave={() => setDismissed(false)} onBlur={() => setDismissed(false)}
    onKeyDown={event => { if (event.key === 'Escape') setDismissed(true) }}>
    <button {...props} ref={ref} type="button" className={`button icon-button ${className}`}
      aria-label={label} aria-describedby={id}>
      <Icon name={icon} />
    </button>
    <span id={id} role="tooltip" className="icon-tooltip">{tooltip}</span>
  </span>
}
