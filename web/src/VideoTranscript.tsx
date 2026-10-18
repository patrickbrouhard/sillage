import { useEffect, useRef, useState } from 'react'
import { fetchTranscript, getTranscript, TranscriptError } from './transcriptApi'
import type { TranscriptExcerpt } from './transcriptSelection'
import type { Transcript } from './transcriptApi'
import { TranscriptText } from './TranscriptText'
import { IconButton } from './IconButton'

/** Garde le dernier contenu consultable indépendamment des opérations et de leurs erreurs. */
export function VideoTranscript({ videoID, sourceID, onNavigate, onCite }: {
  videoID: number
  sourceID: number
  onNavigate: (startMs: number) => string
  onCite: (excerpt: TranscriptExcerpt) => void
}) {
  const [navigationMessage, setNavigationMessage] = useState('')
  const [content, setContent] = useState<Transcript | null | undefined>()
  const [busy, setBusy] = useState<'read' | 'fetch' | null>('read')
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  const operation = useRef<AbortController | null>(null)

  /** Relit localement sans effacer le contenu déjà affiché pendant la requête. */
  async function read() {
    operation.current?.abort()
    const controller = new AbortController()
    operation.current = controller
    setBusy('read'); setMessage(''); setFailed(false)
    try {
      const result = await getTranscript(videoID, sourceID, controller.signal)
      if (!controller.signal.aborted) setContent(result)
    } catch (error) {
      if (!controller.signal.aborted) {
        setFailed(true)
        setMessage(error instanceof Error ? error.message : 'Impossible de lire la transcription locale.')
      }
    } finally {
      if (!controller.signal.aborted) setBusy(null)
    }
  }

  useEffect(() => {
    void read()
    return () => operation.current?.abort()
    // Le parent associe le panneau à la source ; toute ancienne réponse est annulée.
  }, [videoID, sourceID])

  /** Lance une seule acquisition et vérifie localement les réponses de transport incertaines. */
  async function acquire() {
    if (busy) return
    operation.current?.abort()
    const controller = new AbortController()
    operation.current = controller
    setBusy('fetch'); setMessage(''); setFailed(false)
    try {
      const result = await fetchTranscript(videoID, sourceID, controller.signal)
      if (!controller.signal.aborted) setContent(result)
    } catch (error) {
      if (controller.signal.aborted) return
      let description = error instanceof Error ? error.message : 'L’acquisition a échoué.'
      if (error instanceof TranscriptError && error.uncertain) {
        setMessage('Résultat incertain : vérification de la transcription locale…')
        try {
          const recovered = await getTranscript(videoID, sourceID, controller.signal)
          if (controller.signal.aborted) return
          // Une ancienne acquisition ne prouve pas que le POST vient de réussir.
          if (recovered) setContent(recovered)
          description += recovered
            ? ' Le contenu enregistré localement reste consultable ; l’actualisation n’est pas confirmée.'
            : ' Aucune transcription locale n’a été retrouvée.'
        } catch {
          description += ' La vérification locale a également échoué.'
        }
      }
      if (!controller.signal.aborted) { setFailed(true); setMessage(description) }
    } finally {
      if (!controller.signal.aborted) setBusy(null)
    }
  }

  const heading = <h2 id="transcript-title">Transcription{content &&
    <span className="transcript-provenance"> · {content.language.toUpperCase()} · automatique</span>}
  </h2>
  const acquisition = <IconButton icon={content ? 'refresh' : 'download'}
    label={content ? 'Actualiser la transcription' : 'Récupérer la transcription'}
    tooltip={content
      ? `Actualiser la transcription — Acquisition du ${new Date(content.last_fetched_at).toLocaleString('fr-FR')}`
      : 'Récupérer la transcription'}
    disabled={busy !== null} aria-busy={busy === 'fetch'} onClick={() => void acquire()} />
  const feedback = <>
    {navigationMessage && <p role="status">{navigationMessage}</p>}
    {failed && <button className="button" disabled={busy !== null} onClick={() => void read()}>Relire la transcription locale</button>}
    {busy && <p role="status">{busy === 'read' ? 'Chargement de la transcription locale…'
      : content ? 'Actualisation en cours…' : 'Récupération en cours…'}</p>}
    {message && <p role={failed ? 'alert' : 'status'}>{message}</p>}
    {content === null && !busy && !message &&
      <p>Aucune transcription enregistrée localement. Utilisez le bouton de récupération pour la télécharger.</p>}
  </>

  return <section className="video-transcript" aria-labelledby="transcript-title">
    {content ? <TranscriptText key={`${videoID}:${sourceID}`} items={content.items} onCite={onCite}
      heading={heading} acquisition={acquisition} feedback={feedback}
      onNavigate={startMs => setNavigationMessage(onNavigate(startMs))} /> : <>
      <div className="transcript-heading">{heading}{acquisition}</div>
      {feedback}
    </>}
  </section>
}
