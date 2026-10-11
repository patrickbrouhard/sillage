import { useEffect, useState, useSyncExternalStore } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MarkdownEditor } from './MarkdownEditor'
import { NoteSession } from './noteSession'

/** Présente une note locale et son état confirmé, avec modes partageant la même source. */
export function VideoNote({ videoID }: { videoID: number }) {
  const [session] = useState(() => new NoteSession(videoID))
  const state = useSyncExternalStore(session.subscribe, session.snapshot)
  const [reading, setReading] = useState(false)
  const [initial, setInitial] = useState<string | null>(null)
  useEffect(() => {
    void session.start()
    return () => session.stop()
  }, [session])
  useEffect(() => {
    if (state.loaded && initial === null) setInitial(state.content)
  }, [state.loaded, state.content, initial])

  // Le raccourci fonctionne aussi en Lecture et ne déclenche jamais le dialogue du navigateur.
  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault(); void session.save(true)
      }
    }
    window.addEventListener('keydown', save)
    return () => window.removeEventListener('keydown', save)
  }, [session])

  const status = state.phase === 'saving' ? 'Enregistrement…'
    : state.phase === 'error' || state.phase === 'conflict' ? state.message
    : session.dirty ? 'Modifications en attente'
    : state.confirmed ? 'Enregistré' : 'Aucune note enregistrée'

  return <section className="video-note" aria-labelledby="note-title">
    <h2 id="note-title">Note</h2>
    {!state.loaded ? <>
      <p role="status">{state.message || 'Chargement de la note…'}</p>
      {state.message && <button className="button" onClick={() => void session.start()}>Relire la note</button>}
    </> : <>
      <div className="note-toolbar" aria-label="Mode de la note">
        <button className="button" aria-pressed={!reading} onClick={() => setReading(false)}>Édition</button>
        <button className="button" aria-pressed={reading} onClick={() => setReading(true)}>Lecture</button>
        <button className="button" disabled={state.phase === 'conflict'}
          onClick={() => void session.save(true)}>{state.phase === 'error' ? 'Réessayer la sauvegarde' : 'Enregistrer la note'}</button>
      </div>
      <div hidden={reading}>
        {initial !== null && <MarkdownEditor initial={initial} onChange={session.change} onSave={() => void session.save(true)} />}
      </div>
      {reading && <div className="markdown-reading" aria-label="Lecture de la note">
        {state.content ? <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{state.content}</ReactMarkdown> : <p>Note vide.</p>}
      </div>}
      <p role="status" aria-label="État de la note">{status}</p>
      {state.confirmed && <p className="muted">Dernier contenu confirmé : révision {state.confirmed.revision} · <time dateTime={state.confirmed.updated_at}>{new Date(state.confirmed.updated_at).toLocaleTimeString('fr-FR')}</time></p>}
    </>}
  </section>
}
