import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { IconButton } from './IconButton'
import { useAssetUsage } from './useAssetUsage'
import type { NoteSession } from './noteSession'
import type { VideoSource } from './api'
import { listAssets } from './assetApi'
import type { Asset, AssetPage } from './assetApi'
import { formatDuration, providerLabel } from './videoPresentation'

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
export function Images({ videoID, sources, narrow, returnTo, onClose, reading, onInsert, session, departureBlocked, catalogueVersion }: {
  catalogueVersion: number
  departureBlocked: boolean
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
  const usage = useAssetUsage(session, note)
  const panel = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const viewer = useRef<HTMLDialogElement>(null)
  const thumbnail = useRef<HTMLButtonElement | null>(null)
  const originAsset = useRef<number | null>(null)
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
    // Le bouton de réessai disparaît pendant le chargement : garder un contrôle de clavier stable.
    const target = viewer.current?.contains(document.activeElement)
      ? viewer.current.querySelector<HTMLButtonElement>('.lightbox-close button')
      : document.getElementById(`image-card-${id}`)
    target?.focus({ preventScroll: true })
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

  /** Couvre aussi le commit où la note vient d'ouvrir sa protection avant la remontée du signal React. */
  function noteDepartureOpen() {
    return departureBlocked || document.querySelector('dialog.note-navigation[open]') !== null
  }

  useLayoutEffect(() => {
    // Ne pas remonter Images ou la lightbox dans la pile native au-dessus de la protection de départ.
    if (noteDepartureOpen()) return
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
  }, [narrow, departureBlocked])

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
        // Ne conserver que l'état d'affichage de la page reçue, même si des captures s'y ajoutent.
        setDisplays(previous => ({
          page,
          items: Object.fromEntries(value.assets.flatMap(asset => {
            const display = previous.page === page ? previous.items[asset.id] : undefined
            return display ? [[asset.id, display]] : []
          })),
        }))
        // Seule une page contenant une génération active nécessite un suivi temporaire.
        if (value.assets.some(a => a.status === 'pending')) timer = setTimeout(() => void load(), 2000)
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Impossible de consulter les images.')
      } finally { if (!controller.signal.aborted) setBusy(false) }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [videoID, page, attempt, catalogueVersion])

  useLayoutEffect(() => {
    if (!noteDepartureOpen() && enlarged && !viewer.current?.open) viewer.current?.showModal()
  }, [enlarged, departureBlocked])

  /** Le retour vise la commande d'origine et conserve le défilement de la grille. */
  function closeViewer() {
    viewer.current?.close()
    setEnlarged(null)
    const origin = thumbnail.current?.isConnected ? thumbnail.current
      : originAsset.current !== null ? document.getElementById(`image-card-${originAsset.current}`) : null
    const target = origin ?? heading.current
    target?.focus({ preventScroll: true })
  }

  useEffect(() => {
    if (enlarged && result?.page === page && !result.assets.some(asset => asset.id === enlarged.id && asset.status === 'available')) {
      closeViewer()
      setInsertionError('Le catalogue a changé. Choisissez une image de cette page.')
    }
  }, [result, page, enlarged])

  const items = result?.page === page ? result.assets : []
  // La navigation reste dans la page consultée ; les opérations non terminées ne sont pas des images.
  const viewable = items.filter(asset => asset.status === 'available')
  const viewIndex = viewable.findIndex(asset => asset.id === enlarged?.id)
  const viewedSource = sources.find(source => source.id === enlarged?.source_id)

  function moveImage(direction: -1 | 1) {
    const next = viewable[viewIndex + direction]
    if (next) {
      // Une flèche depuis une erreur peut retirer le bouton focalisé avec son image.
      if (viewer.current?.querySelector('.lightbox-stage')?.contains(document.activeElement)) {
        viewer.current.querySelector<HTMLButtonElement>(direction < 0 ? '.lightbox-previous button' : '.lightbox-next button')?.focus({ preventScroll: true })
      }
      setEnlarged(next)
    }
  }
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
          const count = usage.counts.get(asset.id) ?? 0
          return <div className="image-card" key={asset.id} id={`image-card-${asset.id}`} tabIndex={-1}>
            <div className="image-preview">
              {renderImage(asset)}
              {asset.status === 'available' && display.status !== 'error' && <button type="button" className="image-enlarge"
                aria-label={`Agrandir la capture à ${time}, ${provenance}`} onClick={event => {
                  thumbnail.current = event.currentTarget
                  originAsset.current = asset.id
                  setEnlarged(asset)
                }} />}
              {sources.length > 1 && <span className="image-provenance" title={source?.title}>{provenance}</span>}
            </div>
            <div className="image-card-bar">
              <span className="image-time">{time}</span>
              {count > 0 && <span className="image-usage" aria-busy={usage.pending} aria-label={`${count} utilisation${count > 1 ? 's' : ''} dans la note courante`}>×{count}</span>}
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
      aria-describedby="image-viewer-position image-viewer-scope"
      onClick={event => {
        event.stopPropagation()
        if (event.target === event.currentTarget) closeViewer()
      }}
      onKeyDown={event => {
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault(); event.stopPropagation()
        moveImage(event.key === 'ArrowLeft' ? -1 : 1)
      }}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); closeViewer() }}>
      <div className="lightbox-close">
        <IconButton icon="clear" label="Fermer l’agrandissement" className="lightbox-command" onClick={closeViewer} />
      </div>
      <div className="lightbox-previous">
        <IconButton icon="previous" label="Image précédente" className="lightbox-command"
          aria-disabled={viewIndex <= 0} onClick={() => { if (viewIndex > 0) moveImage(-1) }} />
      </div>
      <div className="lightbox-stage" onClick={event => { if (event.target === event.currentTarget) closeViewer() }}>
        {enlarged && renderImage(enlarged, true)}
      </div>
      <div className="lightbox-next">
        <IconButton icon="next" label="Image suivante" className="lightbox-command"
          aria-disabled={viewIndex >= viewable.length - 1} onClick={() => { if (viewIndex < viewable.length - 1) moveImage(1) }} />
      </div>
      <p id="image-viewer-position" className="lightbox-caption" role="status">
        {enlarged && <span>
          {formatDuration(enlarged.timestamp_ms)}
          {sources.length > 1 && <> · {providerLabel(viewedSource?.provider)} · source {enlarged.source_id}</>}
        </span>}
        <span className="lightbox-position" aria-label={`Image ${viewIndex + 1} sur ${viewable.length}, page ${page}`}
          title={`Images disponibles de la page ${page}`}>{viewIndex + 1} / {viewable.length}</span>
      </p>
      <p id="image-viewer-scope" className="sr-only">Navigation limitée aux images disponibles de cette page.</p>
    </dialog>
  </dialog>
}
