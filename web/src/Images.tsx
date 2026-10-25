import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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

/** Affiche les octets connus sans requête d'état individuelle ni génération de réparation. */
function CatalogueImage({ asset, enlarged = false }: { asset: Asset; enlarged?: boolean }) {
  const [unavailable, setUnavailable] = useState(false)
  const [attempt, setAttempt] = useState(0)
  if (asset.status === 'pending') return <span role="status">Capture en cours de génération…</span>
  if (asset.status === 'failed') return <span role="status">La génération de cette capture a échoué ou a été interrompue.</span>
  if (unavailable) return <span role="status">Image indisponible.
    <button type="button" className="button" onClick={() => { setAttempt(value => value + 1); setUnavailable(false) }}>Réessayer l’affichage</button>
  </span>
  return <img key={attempt} src={`/api/v1/assets/${asset.id}/content`} alt=""
    loading={enlarged ? 'eager' : 'lazy'} decoding="async" onError={() => setUnavailable(true)} />
}

/** Catalogue temporaire : drawer non modal à droite, même arbre dans une modale étroite. */
export function Images({ videoID, sources, narrow, returnTo, onClose, reading, onInsert }: {
  reading: boolean
  onInsert: (asset: Asset) => void
  videoID: number
  sources: VideoSource[]
  narrow: boolean
  returnTo: HTMLElement | null
  onClose: () => void
}) {
  const panel = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const viewer = useRef<HTMLDialogElement>(null)
  const thumbnail = useRef<HTMLButtonElement | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [insertionError, setInsertionError] = useState('')
  const [enlarged, setEnlarged] = useState<Asset | null>(null)
  const [page, setPage] = useState(1)
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
    thumbnail.current?.focus({ preventScroll: true })
  }

  const items = result?.page === page ? result.assets : []
  return <dialog ref={panel} className="images-selector" aria-labelledby="images-title"
    aria-modal={narrow ? true : undefined}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); close() }}>
    <header className="images-heading">
      <h2 ref={heading} id="images-title" tabIndex={-1}>Images</h2>
      <button ref={closeButton} type="button" className="button" onClick={close}>Fermer Images</button>
    </header>
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
          return <div className="image-card" key={asset.id}>
            <CatalogueImage asset={asset} />
            {asset.status === 'available' && <button type="button" className="image-enlarge"
              aria-label={`Agrandir la capture à ${time}, ${provenance}`} onClick={event => {
                thumbnail.current = event.currentTarget; setEnlarged(asset)
              }} />}
            <button type="button" className="image-insert" disabled={reading || asset.status !== 'available'}
              aria-label={`Insérer la capture à ${time}, ${provenance}`} onClick={() => {
                try { onInsert(asset); setInsertionError('') }
                catch (error) { setInsertionError(error instanceof Error ? error.message : 'Insertion impossible.') }
              }}>+</button>
            <span className="image-provenance" title={source?.title}>{provenance}</span>
            <span className="image-time">{time}</span>
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
      {enlarged && <CatalogueImage key={enlarged.id} asset={enlarged} enlarged />}
    </dialog>
  </dialog>
}
