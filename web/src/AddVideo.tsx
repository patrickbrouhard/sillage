import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router'
import { addVideo, errorMessage } from './api'

type AddState =
  | { status: 'idle' | 'pending' }
  | { status: 'error'; message: string }
  | { status: 'success'; id: number; created: boolean }

/** Lance une seule acquisition explicite et conserve la saisie après un échec. */
export function AddVideo() {
  const [url, setURL] = useState('')
  const [state, setState] = useState<AddState>({ status: 'idle' })
  const activeRequest = useRef<AbortController | null>(null)

  useEffect(() => () => activeRequest.current?.abort(), [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // Le verrou synchrone couvre deux événements avant le prochain rendu React.
    if (activeRequest.current) return
    const controller = new AbortController()
    activeRequest.current = controller
    setState({ status: 'pending' })
    try {
      const result = await addVideo(url.trim(), controller.signal)
      if (!controller.signal.aborted) {
        setState({ status: 'success', id: result.video.id, created: result.created })
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setState({
          status: 'error',
          message: errorMessage(error, 'La connexion a été interrompue. Vérifiez la bibliothèque avant de réessayer : la vidéo a peut-être été enregistrée.'),
        })
      }
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null
    }
  }

  return (
    <div className="narrow-page">
      <title>Ajouter une vidéo · Sillage</title>
      <Link className="back-link" to="/">← Revenir à la bibliothèque</Link>
      <p className="eyebrow">ENRICHIR LA BIBLIOTHÈQUE</p>
      <h1>Ajouter une vidéo</h1>
      <p className="intro">Collez une URL YouTube pour conserver la vidéo et ses informations.</p>
      <form className="add-form" onSubmit={submit} aria-busy={state.status === 'pending'}>
        <label htmlFor="video-url">URL YouTube</label>
        <input
          id="video-url"
          name="url"
          type="url"
          required
          value={url}
          placeholder="https://www.youtube.com/watch?v=…"
          autoComplete="url"
          aria-describedby="url-help"
          disabled={state.status === 'pending'}
          onChange={(event) => {
            setURL(event.target.value)
            setState({ status: 'idle' })
          }}
        />
        <p id="url-help">Une vidéo déjà enregistrée sera retrouvée sans créer de doublon.</p>
        <button className="button primary" type="submit" disabled={state.status === 'pending'}>
          {state.status === 'pending' ? 'Acquisition en cours…' : 'Ajouter la vidéo'}
        </button>
      </form>
      {state.status === 'pending' && (
        <p className="notice" role="status">Récupération des métadonnées YouTube… Cette opération peut prendre quelques instants.</p>
      )}
      {state.status === 'error' && (
        <div className="notice error" role="alert">{state.message}</div>
      )}
      {state.status === 'success' && (
        <div className="notice success">
          <p role="status">{state.created ? 'Vidéo ajoutée à la bibliothèque.' : 'Cette vidéo est déjà présente dans la bibliothèque.'}</p>
          <Link className="button primary" to={`/videos/${state.id}`}>Ouvrir la fiche</Link>
        </div>
      )}
    </div>
  )
}
