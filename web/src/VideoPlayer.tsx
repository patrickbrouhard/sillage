import { useCallback, useEffect, useId, useImperativeHandle, useRef, useState } from 'react'
import type { Ref } from 'react'
import type { VideoSource } from './api'
import type { useVideoDownload } from './useVideoDownload'
import type { MediaFile } from './mediaApi'
import { downloadMessage } from './mediaApi'
import type { PlayerHandle, PlayerSurfaceHandle, PlayerVisibility } from './player'
import { YouTubePlayer } from './YouTubePlayer'
import { LocalPlayer } from './LocalPlayer'
import { IconButton } from './IconButton'
import { VideoDownload } from './VideoDownload'
import { PlayerInformation } from './PlayerInformation'

/** Conserve l'en-tête, le focus et les interactions de conservation hors des instances de lecture. */
export function VideoPlayer({ videoID, source, download, ref, covered = false, onImagesFailure }: {
  onImagesFailure: (message: string) => void
  covered?: boolean
  videoID: number
  source: VideoSource
  download: ReturnType<typeof useVideoDownload>
  ref: Ref<PlayerHandle>
}) {
  const player = useRef<PlayerSurfaceHandle>(null)
  const [selection, setSelection] = useState<{ mode: 'youtube' | 'local'; startMs?: number } | null>(null)
  const [visibility, setVisibility] = useState<PlayerVisibility>({ hidden: false, hiding: false })
  const [message, setMessage] = useState('')
  const [unloaded, setUnloaded] = useState<number>()
  const [information, setInformation] = useState(false)
  const informationButton = useRef<HTMLButtonElement>(null)
  const localButton = useRef<HTMLButtonElement>(null)
  const downloadButton = useRef<HTMLButtonElement | null>(null)
  // React détache la ref avant de retirer le bouton : le focus ne tombe pas sur body.
  const attachDownloadButton = useCallback((node: HTMLButtonElement | null) => {
    if (!node && downloadButton.current === document.activeElement) localButton.current?.focus()
    downloadButton.current = node
  }, [])
  const popover = useRef<HTMLDivElement>(null)
  const downloadDialog = useRef<HTMLDialogElement>(null)
  const deleteDialog = useRef<HTMLDialogElement>(null)
  const deletion = useRef<MediaFile | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const popoverID = useId()
  const deleteTitleID = useId()

  useEffect(() => {
    if (!information) return
    popover.current?.focus()
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!popover.current?.contains(target) && !informationButton.current?.contains(target)) setInformation(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setInformation(false)
      informationButton.current?.focus()
    }
    // Un clic dans l'iframe YouTube ne traverse pas le document parent.
    // Le changement de focus ferme alors le popover sans reprendre le focus.
    let frameTimer: number | undefined
    const frameFocus = () => {
      frameTimer = window.setTimeout(() => {
        if (document.activeElement?.tagName === 'IFRAME') setInformation(false)
      }, 0)
    }
    window.addEventListener('blur', frameFocus)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('blur', frameFocus)
      window.clearTimeout(frameTimer)
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [information])

  useImperativeHandle(ref, () => ({
    getCurrentTimeMs() {
      if (!player.current) throw new Error('Temps indisponible : aucun lecteur prêt.')
      return player.current.getCurrentTimeMs()
    },
    navigate: startMs => player.current?.navigate(startMs) ?? 'Navigation non effectuée : lecteur indisponible.',
    stop: () => player.current?.stop(),
    prepareImages: async () => { await player.current?.prepareImages() },
    releaseImages: () => player.current?.releaseImages(),
  }))

  // Les consultations suivantes ne remplacent jamais le choix de cette session.
  if (selection === null && (download.state || download.error)) {
    setSelection({ mode: download.state?.status === 'available' ? 'local' : 'youtube' })
  }

  /** Réutilise la même fenêtre depuis les segments, les informations et le panneau vide. */
  function showDownload() {
    returnFocus.current = downloadButton.current === document.activeElement ? downloadButton.current : localButton.current
    setInformation(false)
    if (!downloadDialog.current?.open) downloadDialog.current?.showModal()
  }

  /** Fige l'identité visée ; l'ouverture d'une confirmation n'arrête aucune lecture. */
  function showDelete() {
    if (!download.file || download.busy) return
    deletion.current = download.file
    returnFocus.current = informationButton.current
    setInformation(false)
    downloadDialog.current?.close()
    deleteDialog.current?.showModal()
  }

  function selectMode(mode: 'youtube' | 'local') {
    if (!selection) return
    if (mode === 'local' && download.state?.status !== 'available') {
      showDownload()
      return
    }
    if (mode === selection.mode) return
    // Le curseur de session circule uniquement entre surfaces de cette source.
    // Les commandes de connaissance continuent de lire exclusivement le temps confirmé.
    const position = player.current?.getTransferPosition() ?? { kind: 'uncertain' }
    const startMs = 'milliseconds' in position ? position.milliseconds : undefined
    player.current?.stop()
    setInformation(false)
    setMessage(position.kind === 'uncertain' ? 'Lecteur changé sans transfert de position : le temps précédent était indisponible.' : '')
    setUnloaded(undefined)
    setSelection({ mode, startMs })
  }

  const file = download.state?.status === 'available' ? download.file : null
  const url = file && file.id !== unloaded ? `/api/v1/videos/${videoID}/media-files/${file.id}/content` : undefined
  const activity = download.requesting || download.state?.status === 'downloading'
  const indicator = activity ? 'progress' : download.result
  const announcement = activity ? 'Téléchargement en cours sur le serveur…' :
    indicator === 'success' ? 'Téléchargement terminé.' : indicator === 'failure' ? 'Échec du téléchargement.' : ''
  const showDownloadCommand = activity || Boolean(download.result) || download.state?.status !== 'available'
  const downloadLabel = announcement || (download.error || download.state?.status === 'failed'
    ? 'Consulter le téléchargement' : 'Télécharger la vidéo')
  const error = download.error || (download.state?.error ? downloadMessage(download.state.error.code) : '')

  return <section inert={covered} className="video-player" aria-label="Lecteur">
    <div className="player-toolbar">
      <div className="player-mode-controls">
        <div className="player-segments segmented-control" role="group" aria-label="Mode de lecture">
          <button className="segmented-button" type="button" aria-pressed={selection?.mode === 'youtube'} disabled={!selection} onClick={() => selectMode('youtube')}>YouTube</button>
          <button className="segmented-button" type="button" ref={localButton} aria-pressed={selection?.mode === 'local'} disabled={!selection}
            onClick={() => selectMode('local')}>
            Local
          </button>
        </div>
        {showDownloadCommand && <IconButton ref={attachDownloadButton}
          icon={activity ? 'spinner' : indicator === 'success' ? 'check' : indicator === 'failure' ? 'clear' : 'download'}
          label={downloadLabel} className={`download-command ${indicator ?? ''}`} disabled={!selection}
          aria-haspopup="dialog" onClick={showDownload} />}
      </div>
      <div className="player-toolbar-actions">
        <IconButton icon="info" label="Informations" ref={informationButton} disabled={!selection}
          aria-expanded={information} aria-controls={popoverID} onClick={() => setInformation(value => !value)} />
        <IconButton icon={visibility.hidden ? 'eye' : 'eye-off'} disabled={!selection || visibility.hiding}
          aria-expanded={!visibility.hidden} aria-busy={visibility.hiding}
          label={visibility.hidden ? 'Afficher la vidéo' : visibility.hiding ? 'Mise en pause…' : 'Masquer la vidéo'}
          onClick={() => player.current?.toggleVisibility()} />
      </div>
      {information && selection && <div ref={popover} id={popoverID} role="dialog" aria-label="Informations vidéo"
        tabIndex={-1} className="player-information">
        <button className="button information-close" onClick={() => {
          setInformation(false)
          informationButton.current?.focus()
        }}>Fermer les informations</button>
        <PlayerInformation mode={selection.mode} source={source} download={download} onDelete={showDelete} onDownload={showDownload} />
      </div>}
    </div>
    <span className="sr-only" role="status">{announcement}</span>
    {error && <div className="player-error" role="alert"><p>{error}</p>
      <button className="button" onClick={showDownload}>Consulter le téléchargement</button></div>}
    {!selection ? <p role="status">Consultation du fichier local…</p> :
      selection.mode === 'youtube' ?
        <YouTubePlayer onImagesFailure={onImagesFailure} source={source} ref={player} onVisibility={setVisibility} initialStartMs={selection.startMs} /> :
        <>
          {!file && <div className="local-empty"><p>{download.state?.status === 'downloading' ? 'Téléchargement en cours sur le serveur…' :
            download.state?.status === 'not_downloaded' ? 'Aucun fichier local. Téléchargez cette source pour la regarder ici.' :
            'Le fichier local est indisponible.'}</p>
            <button className="button" onClick={showDownload}>{download.state?.status === 'not_downloaded' ? 'Télécharger le fichier local' : 'Gérer le téléchargement'}</button>
          </div>}
          {file && file.id === unloaded && <button className="button" onClick={() => setUnloaded(undefined)}>Recharger le lecteur local</button>}
          <LocalPlayer ref={player} onVisibility={setVisibility} url={url} initialStartMs={selection.startMs} />
        </>}
    <p className="player-switch-status" role="status">{message}</p>
    <VideoDownload download={download} ref={downloadDialog} onDelete={showDelete} onClose={() => {
      // Le retour peut disparaître après un succès pendant que la modale est ouverte.
      if (!deleteDialog.current?.open) {
        const target = returnFocus.current
        if (target?.isConnected) target.focus()
        else localButton.current?.focus()
      }
    }} />
    <dialog ref={deleteDialog} className="tag-dialog media-dialog" aria-labelledby={deleteTitleID}
      onClose={() => informationButton.current?.focus()}>
      <h2 id={deleteTitleID}>Supprimer le fichier local ?</h2>
      <p>La vidéo, les notes, les transcriptions et les captures restent conservées. Seul le fichier média local sera supprimé.</p>
      <div className="download-actions">
        <button className="button" autoFocus onClick={() => deleteDialog.current?.close()}>Annuler</button>
        <button className="button" disabled={download.busy} onClick={() => {
          const target = deletion.current
          deleteDialog.current?.close()
          if (!target || download.busy) return
          // Une suppression depuis YouTube ne doit pas arrêter le lecteur distant.
          if (selection?.mode === 'local') {
            player.current?.stop()
            setUnloaded(target.id)
          }
          void download.mutate(target)
        }}>Confirmer la suppression</button>
      </div>
    </dialog>
  </section>
}
