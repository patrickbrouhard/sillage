import { useImperativeHandle, useRef, useState } from 'react'
import type { Ref } from 'react'
import type { VideoSource } from './api'
import type { useVideoDownload } from './useVideoDownload'
import type { PlayerHandle, PlayerSurfaceHandle, PlayerVisibility } from './player'
import { YouTubePlayer } from './YouTubePlayer'
import { LocalPlayer } from './LocalPlayer'
import { IconButton } from './IconButton'
import { VideoDownload } from './VideoDownload'

/** Compose deux lecteurs concrets ; le choix initial privilégie le média disponible de la source de travail. */
export function VideoPlayer({ videoID, source, download, ref }: {
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
  useImperativeHandle(ref, () => ({
    getCurrentTimeMs() {
      if (!player.current) throw new Error('Temps indisponible : aucun lecteur prêt.')
      return player.current.getCurrentTimeMs()
    },
    navigate: startMs => player.current?.navigate(startMs) ?? 'Navigation non effectuée : lecteur indisponible.',
    stop: () => player.current?.stop(),
  }))
  // Le choix initial reste indépendant des consultations et acquisitions ultérieures.
  if (selection === null && (download.state || download.error)) {
    setSelection({ mode: download.state?.status === 'available' ? 'local' : 'youtube' })
  }
  function selectMode(mode: 'youtube' | 'local') {
    if (!selection || mode === selection.mode) return
    let startMs: number | undefined
    try { startMs = player.current?.getCurrentTimeMs() } catch { /* Une position non confirmée ne bloque pas la bascule. */ }
    player.current?.stop()
    setMessage(startMs === undefined ? 'Lecteur changé sans transfert de position : le temps précédent était indisponible.' : '')
    setUnloaded(undefined)
    setSelection({ mode, startMs: mode === 'local' && download.state?.status !== 'available' ? undefined : startMs })
  }
  const file = download.state?.status === 'available' ? download.file : null
  const url = file && file.id !== unloaded ? `/api/v1/videos/${videoID}/media-files/${file.id}/content` : undefined
  return <section className="video-player" aria-label="Lecteur">
    <div className="player-toolbar">
      <div className="player-segments" role="group" aria-label="Mode de lecture">
        <button type="button" aria-pressed={selection?.mode === 'youtube'} disabled={!selection} onClick={() => selectMode('youtube')}>YouTube</button>
        <button type="button" aria-pressed={selection?.mode === 'local'} disabled={!selection} onClick={() => selectMode('local')}>Local</button>
      </div>
      {selection?.mode === 'local' ? <VideoDownload download={download} beforeDelete={file => {
        player.current?.stop()
        setUnloaded(file.id)
      }} /> : <span className="player-spacer" />}
      <IconButton icon={visibility.hidden ? 'eye' : 'eye-off'} disabled={!selection || visibility.hiding}
        aria-expanded={!visibility.hidden} aria-busy={visibility.hiding}
        label={visibility.hidden ? 'Afficher la vidéo' : visibility.hiding ? 'Mise en pause…' : 'Masquer la vidéo'}
        onClick={() => player.current?.toggleVisibility()} />
    </div>
    <p className="player-switch-status" role="status">{message}</p>
    {!selection ? <p role="status">Consultation du fichier local…</p> :
      selection.mode === 'youtube' ?
        <YouTubePlayer source={source} ref={player} onVisibility={setVisibility} initialStartMs={selection.startMs} /> :
        <>
          {download.state?.status === 'not_downloaded' && <p className="muted">Aucun fichier local. Téléchargez cette source pour la regarder ici.</p>}
          {file && file.id === unloaded && <button className="button" onClick={() => setUnloaded(undefined)}>Recharger le lecteur local</button>}
          <LocalPlayer ref={player} onVisibility={setVisibility} url={url} initialStartMs={selection.startMs} />
        </>}
  </section>
}
