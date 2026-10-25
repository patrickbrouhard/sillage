import { useEffect, useLayoutEffect, useRef, useState, useMemo, useSyncExternalStore } from 'react'
import { IconButton } from './IconButton'
import { countAssetImages } from './assetUsage'
import type { NoteSession } from './noteSession'
import type { VideoSource } from './api'
import { listAssets } from './assetApi'
import type { Asset, AssetPage } from './assetApi'
import { formatDuration, providerLabel } from './videoPresentation'

/** Suit le même seuil que la grille, sans remplacer ses composants. */
export function useNarrowWorkspace() {
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1099px)').matches)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1099px)')
    const change = () => setNarrow(query.matches)
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [])
  return narrow
}

interface ImageDisplay {
  status: 'loading' | 'loaded' | 'error'
  attempt: number
}
const initialDisplay: ImageDisplay = { status: 'loading', attempt: 0 }

/** Partage les erreurs entre les surfaces ; chaque élément garde son attente de décodage propre. */
function CatalogueImage({ asset, display, onStatus, onRetry, enlarged = false }: {
  asset: Asset
  display: ImageDisplay
  onStatus: (status: 'loaded' | 'error') => void
  onRetry: () => void
  enlarged?: boolean
}) {
  const [loaded, setLoaded] = useState(false)
  if (asset.status === 'pending') return <span role="status">Capture en cours de génération…</span>
  if (asset.status === 'failed') return <span role="status">La génération de cette capture a échoué ou a été interrompue.</span>
  if (display.status === 'error') return <span role="status" className="image-display-error">Image indisponible.
    <button type="button" className="button" onClick={onRetry}>Réessayer l’affichage</button>
  </span>
  return <>
    <img src={`/api/v1/assets/${asset.id}/content`} alt=""
      loading={enlarged ? 'eager' : 'lazy'} decoding="async" className={loaded ? '' : 'image-decoding'}
      onLoad={() => { setLoaded(true); onStatus('loaded') }} onError={() => onStatus('error')} />
    {!loaded && <span className="image-loading" role="status">Chargement de l’image…</span>}
  </>
}

/** Catalogue temporaire : drawer non modal à droite, même arbre dans une modale étroite. */
export function Images({ videoID, sources, narrow, returnTo, onClose, reading, onInsert, session }: {
  session: NoteSession
  reading: boolean
  onInsert: (asset: Asset) => void
  videoID: number
  sources: VideoSource[]
  narrow: boolean
  returnTo: HTMLElement | null
  onClose: () => void
}) {
  const note = useSyncExternalStore(session.subscribe, session.snapshot)
  const uses = useMemo(() => countAssetImages(note.content), [note.content])
  const panel = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const viewer = useRef<HTMLDialogElement>(null)
  const thumbnail = useRef<HTMLButtonElement | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [insertionError, setInsertionError] = useState('')
  const [enlarged, setEnlarged] = useState<Asset | null>(null)
  const [page, setPage] = useState(1)
  const currentPage = useRef(page)
  currentPage.current = page
  const [displays, setDisplays] = useState<{ page: number; items: Record<number, ImageDisplay> }>({ page, items: {} })

  function displayFor(id: number) { return displays.page === page ? displays.items[id] ?? initialDisplay : initialDisplay }

  /** Une erreur reste bloquante jusqu'à un succès d'un réessai explicite, jamais d'un ancien chargement. */
  function reportDisplay(id: number, attempt: number, status: 'loaded' | 'error') {
    if (currentPage.current !== page) return
    setDisplays(previous => {
      const items = previous.page === page ? previous.items : {}
      const current = items[id] ?? initialDisplay
      if (current.attempt !== attempt || current.status === 'error' || current.status === status) return previous
      return { page, items: { ...items, [id]: { ...current, status } } }
    })
  }

  function retryDisplay(id: number) {
    setDisplays(previous => {
      const items = previous.page === page ? previous.items : {}
      return { page, items: { ...items, [id]: { status: 'loading', attempt: (items[id]?.attempt ?? 0) + 1 } } }
    })
  }

  function renderImage(asset: Asset, enlarged = false) {
    const display = displayFor(asset.id)
    return <CatalogueImage key={`${asset.id}:${display.attempt}`} asset={asset} display={display}
      enlarged={enlarged} onStatus={status => reportDisplay(asset.id, display.attempt, status)}
      onRetry={() => retryDisplay(asset.id)} />
  }
  const [result, setResult] = useState<AssetPage | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useLayoutEffect(() => {
    const dialog = panel.current!
    const focused = document.activeElement as HTMLElement | null
    const scroll = scroller.current?.scrollTop ?? 0
    dialog.close()
    if (narrow) dialog.showModal(); else dialog.show()
    if (focused && dialog.contains(focused)) focused.focus({ preventScroll: true })
    else closeButton.current?.focus({ preventScroll: true })
    if (scroller.current) scroller.current.scrollTop = scroll
    // La visionneuse reste la surface la plus interne après un changement responsive.
    if (viewer.current?.open) { viewer.current.close(); viewer.current.showModal() }
  }, [narrow])

  useEffect(() => () => { viewer.current?.close(); panel.current?.close() }, [])

  /** Ne reprend pas le focus d'une note encore interactive sur desktop. */
  function close() {
    const restore = narrow || document.activeElement === document.body || !!panel.current?.contains(document.activeElement)
    panel.current?.close()
    onClose()
    if (restore && returnTo?.isConnected) returnTo.focus({ preventScroll: true })
  }

  useEffect(() => {
    if (narrow) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog:modal')) return
      event.preventDefault()
      close()
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  })

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function load() {
      setBusy(true)
      try {
        const value = await listAssets(videoID, page, controller.signal)
        if (controller.signal.aborted) return
        setResult(value); setError('')
        // Seule une page contenant une génération active nécessite un suivi temporaire.
        if (value.assets.some(a => a.status === 'pending')) timer = setTimeout(() => void load(), 2000)
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Impossible de consulter les images.')
      } finally { if (!controller.signal.aborted) setBusy(false) }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [videoID, page, attempt])

  useLayoutEffect(() => {
    if (enlarged) viewer.current?.showModal()
  }, [enlarged])

  /** Le retour vise la commande d'origine et conserve le défilement de la grille. */
  function closeViewer() {
    viewer.current?.close()
    setEnlarged(null)
    if (thumbnail.current?.isConnected) thumbnail.current.focus({ preventScroll: true })
    else if (enlarged) document.getElementById(`image-card-${enlarged.id}`)?.focus({ preventScroll: true })
  }

  const items = result?.page === page ? result.assets : []
  return <dialog id="images-selector" ref={panel} className="images-selector" aria-labelledby="images-title"
    aria-modal={narrow ? true : undefined}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); close() }}>
    <header className="images-heading">
      <h2 ref={heading} id="images-title" tabIndex={-1}>Images</h2>
      <IconButton ref={closeButton} icon="clear" label="Fermer Images" onClick={close} />
    </header>
    {!note.loaded && <p className="images-help" role="status">Les utilisations seront disponibles après le chargement de la note.</p>}
    {reading && <p className="images-help">Passez en Édition pour insérer une image.</p>}
    {insertionError && <p role="alert" className="images-help">{insertionError}</p>}
    <div ref={scroller} className="images-scroll" aria-busy={busy}>
      {error && <p role="alert">{error} <button type="button" className="button" onClick={() => setAttempt(value => value + 1)}>Réessayer le catalogue</button></p>}
      {!result && busy && <p role="status">Chargement des images…</p>}
      {result?.page === page && !items.length && !error && <p role="status">{page === 1 ? 'Aucune capture pour cette vidéo.' : 'Aucune image sur cette page.'}</p>}
      <div className="images-grid">
        {items.map(asset => {
          const source = sources.find(source => source.id === asset.source_id)
          const provenance = `${source ? providerLabel(source.provider) : 'Source'}${sources.length > 1 ? ` · source ${asset.source_id}` : ''}`
          const time = formatDuration(asset.timestamp_ms)
          const display = displayFor(asset.id)
          const count = uses.get(asset.id) ?? 0
          return <div className="image-card" key={asset.id} id={`image-card-${asset.id}`} tabIndex={-1}>
            <div className="image-preview">
              {renderImage(asset)}
              {asset.status === 'available' && display.status !== 'error' && <button type="button" className="image-enlarge"
                aria-label={`Agrandir la capture à ${time}, ${provenance}`} onClick={event => {
                  thumbnail.current = event.currentTarget; setEnlarged(asset)
                }} />}
              {sources.length > 1 && <span className="image-provenance" title={source?.title}>{provenance}</span>}
            </div>
            <div className="image-card-bar">
              <span className="image-time">{time}</span>
              {count > 0 && <span className="image-usage" aria-label={`${count} utilisation${count > 1 ? 's' : ''} dans la note courante`}>×{count}</span>}
              <IconButton icon="plus" className="image-insert" label={`Insérer la capture à ${time}, ${provenance}`}
                disabled={reading || asset.status !== 'available' || display.status !== 'loaded'} onClick={() => {
                  try {
                    // Le contrôle accompagne le bouton, sans nouvelle validation réseau à chaque ajout.
                    if (displayFor(asset.id).status !== 'loaded') throw new Error('Attendez un affichage réussi avant d’insérer cette image.')
                    onInsert(asset); setInsertionError('')
                  } catch (error) { setInsertionError(error instanceof Error ? error.message : 'Insertion impossible.') }
                }} />
            </div>
          </div>
        })}
      </div>
      {result && <nav className="images-pagination" aria-label="Pages d’images">
        <button type="button" className="button" disabled={page === 1 || busy} onClick={() => { setPage(value => value - 1); scroller.current?.scrollTo(0, 0); heading.current?.focus({ preventScroll: true }) }}>Précédent</button>
        <span>Page {page}</span>
        <button type="button" className="button" disabled={!result.has_more || busy} onClick={() => { setPage(value => value + 1); scroller.current?.scrollTo(0, 0); heading.current?.focus({ preventScroll: true }) }}>Suivant</button>
      </nav>}
    </div>
    <dialog ref={viewer} className="image-viewer" aria-label="Agrandissement de l’image"
      onCancel={event => { event.preventDefault(); event.stopPropagation(); closeViewer() }}>
      <button type="button" className="button" onClick={closeViewer}>Fermer l’agrandissement</button>
      {enlarged && renderImage(enlarged, true)}
    </dialog>
  </dialog>
}
