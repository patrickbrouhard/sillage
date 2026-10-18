import { useImperativeHandle, useRef, useState } from 'react'
import type { Ref } from 'react'
import type { VideoSource } from './api'
import type { useVideoDownload } from './useVideoDownload'
import type { PlayerHandle } from './player'
import { YouTubePlayer } from './YouTubePlayer'
import { LocalPlayer } from './LocalPlayer'
import { VideoDownload } from './VideoDownload'

/** Compose deux lecteurs concrets ; le choix reste explicite pendant cette phase de validation. */
export function VideoPlayer({ videoID, source, download, ref }: {
  videoID: number
  source: VideoSource
  download: ReturnType<typeof useVideoDownload>
  ref: Ref<PlayerHandle>
}) {
  const player = useRef<PlayerHandle>(null)
  const [selection, setSelection] = useState<{ mode: 'youtube' | 'local'; startMs?: number }>({ mode: 'youtube' })
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
  const heading = <label className="work-source">
    <span className="sr-only">Mode de lecture</span>
    <select aria-label="Mode de lecture" value={selection.mode} onChange={event => {
      const mode = event.target.value as 'youtube' | 'local'
      let startMs: number | undefined
      try { startMs = player.current?.getCurrentTimeMs() } catch { /* Une position non confirmée ne bloque pas la bascule. */ }
      player.current?.stop()
      setMessage(startMs === undefined ? 'Lecteur changé sans transfert de position : le temps précédent était indisponible.' : '')
      setUnloaded(undefined)
      // Aucun transfert latent vers un fichier qui n'existe pas encore.
      setSelection({ mode, startMs: mode === 'local' && download.state?.status !== 'available' ? undefined : startMs })
    }}>
      <option value="youtube">YouTube</option>
      <option value="local">Local</option>
    </select>
  </label>
  const feedback = <p className="player-switch-status" role="status">{message}</p>
  if (selection.mode === 'youtube') return <YouTubePlayer source={source} ref={player}
    heading={heading} status={feedback} initialStartMs={selection.startMs}><span className="player-spacer" /></YouTubePlayer>
  const file = download.state?.status === 'available' ? download.file : null
  const url = file && file.id !== unloaded ? `/api/v1/videos/${videoID}/media-files/${file.id}/content` : undefined
  const status = <>
    {feedback}
    {download.state?.status === 'not_downloaded' && <p className="muted">Aucun fichier local. Téléchargez cette source pour la regarder ici.</p>}
    {file && file.id === unloaded && <button className="button" onClick={() => setUnloaded(undefined)}>Recharger le lecteur local</button>}
  </>
  return <LocalPlayer ref={player} heading={heading} status={status} url={url} initialStartMs={selection.startMs}>
    <VideoDownload download={download} beforeDelete={file => {
      player.current?.stop()
      setUnloaded(file.id)
    }} />
  </LocalPlayer>
}
