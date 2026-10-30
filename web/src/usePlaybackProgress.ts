import { useCallback, useEffect, useRef, useState } from 'react'
import { isAuthenticated, subscribeAuth } from './auth'
import { getPlaybackProgress, savePlaybackProgress } from './playbackApi'
import { PlaybackProgress, PlaybackWrites } from './playbackProgress'
import type { PlaybackObserver } from './playbackProgress'

/** Conserve une session par fiche/source, sans rendre React à chaque observation. */
export function usePlaybackProgress(videoID: number, sourceID: number) {
  const [initial, setInitial] = useState<{ position: number | null } | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [message, setMessage] = useState('')
  const active = useRef(true)
  const enabledRef = useRef(true)
  const policy = useRef(new PlaybackProgress())
  const writer = useRef<PlaybackWrites | null>(null)
  if (!writer.current) writer.current = new PlaybackWrites(
    (position, keepalive) => savePlaybackProgress(videoID, sourceID, position, keepalive),
    failed => { if (active.current) setMessage(failed ? 'Enregistrement du point de reprise non confirmé. La lecture peut continuer.' : '') },
  )

  useEffect(() => {
    active.current = true
    let finished = false
    const controller = new AbortController()
    const finish = (position: number | null, failed: boolean) => {
      if (finished) return
      finished = true
      window.clearTimeout(timer)
      policy.current.restore(position)
      setInitial({ position })
      if (failed) setMessage('Point de reprise indisponible. Lecture possible depuis le début.')
    }
    // Après deux secondes, la décision devient définitive pour cette ouverture.
    const timer = window.setTimeout(() => { finish(null, true); controller.abort() }, 2000)
    void getPlaybackProgress(videoID, sourceID, controller.signal).then(
      position => finish(position, false),
      () => finish(null, true),
    )
    const access = () => {
      const allowed = isAuthenticated() && enabledRef.current
      writer.current!.enable(allowed)
      if (!allowed) policy.current.reset()
    }
    access()
    const unsubscribe = subscribeAuth(access)
    const flush = () => {
      if (enabledRef.current && isAuthenticated()) {
        writer.current!.submit(policy.current.flush(), true)
        writer.current!.finish()
      }
    }
    const hidden = () => { if (document.visibilityState === 'hidden') flush() }
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('pagehide', flush)
    return () => {
      flush()
      active.current = false
      finished = true
      controller.abort()
      window.clearTimeout(timer)
      unsubscribe()
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('pagehide', flush)
      writer.current!.enable(false)
    }
  }, [videoID, sourceID])

  const observe = useCallback<PlaybackObserver>((sample, reason = 'sample') => {
    if (!active.current || !enabledRef.current || !isAuthenticated()) return
    if (reason === 'seek' || reason === 'reset') {
      if (reason === 'seek') policy.current.seek()
      else policy.current.reset()
      return
    }
    writer.current!.submit(policy.current.observe(sample, performance.now()))
    if (reason === 'stop') {
      writer.current!.submit(policy.current.flush())
      policy.current.transfer(sample.positionMs ?? undefined)
    }
  }, [])

  /** Une réactivation n'applique jamais le point reçu du serveur. */
  function toggle() {
    const next = !enabledRef.current
    enabledRef.current = next
    policy.current.reset()
    writer.current!.enable(next && isAuthenticated())
    setEnabled(next)
  }

  /** Une bascule incertaine abandonne les crédits, jamais le point persisté. */
  function transfer(position?: number) {
    policy.current.transfer(position)
  }

  return { initial, enabled, message, observe, toggle, transfer }
}
