import { useEffect, useRef, useState } from 'react'
import { MarkdownEditor } from './MarkdownEditor'
import { getNote, putNote } from './noteApi'
import type { Note } from './noteApi'

/** Première édition avec sauvegarde explicite et conservation du brouillon lors d'un refus. */
export function VideoNote({ videoID }: { videoID: number }) {
  const [loaded, setLoaded] = useState(false)
  const [initial, setInitial] = useState('')
  const [content, setContent] = useState('')
  const [saved, setSaved] = useState<Note | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const writing = useRef(false)
  const lifetime = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    void getNote(videoID, controller.signal).then(note => {
      if (controller.signal.aborted) return
      setSaved(note); setInitial(note?.content_md ?? ''); setContent(note?.content_md ?? '')
      setLoaded(true); setMessage('')
    }).catch(() => {
      if (!controller.signal.aborted) setMessage('Impossible de charger la note.')
    })
    return () => controller.abort()
  }, [videoID, attempt])

  async function save() {
    const signal = lifetime.current!.signal
    if (writing.current || !loaded || (saved && saved.content_md === content)) return
    writing.current = true; setBusy(true); setMessage('')
    try {
      const note = await putNote(videoID, content, saved?.revision ?? 0, signal)
      if (!signal.aborted) { setSaved(note); setMessage('Enregistré') }
    } catch (error) {
      if (!signal.aborted) setMessage(error instanceof Error ? error.message : 'Échec de sauvegarde.')
    } finally {
      writing.current = false
      if (!signal.aborted) setBusy(false)
    }
  }
  return <section className="video-note" aria-labelledby="note-title">
    <h2 id="note-title">Note</h2>
    {!loaded ? <>
      <p role="status">{message || 'Chargement de la note…'}</p>
      {message && <button className="button" onClick={() => setAttempt(x => x + 1)}>Relire la note</button>}
    </> : <>
      <MarkdownEditor initial={initial} onChange={setContent} onSave={() => void save()} />
      <button className="button" disabled={busy} onClick={() => void save()}>Enregistrer la note</button>
      <p role="status">{busy ? 'Enregistrement…' : content !== (saved?.content_md ?? '') ? message || 'Modifications en attente' : message || (saved ? 'Enregistré' : 'Aucune note enregistrée')}</p>
    </>}
  </section>
}
