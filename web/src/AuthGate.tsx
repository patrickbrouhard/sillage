import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { authSnapshot, hasPendingDraft, login, logout, refreshSession, subscribeAuth, startOIDC, completeOIDC } from './auth'

/** Conserve le même arbre applicatif pendant les interruptions d'authentification. */
export function AuthGate({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(subscribeAuth, authSnapshot)
  const dialog = useRef<HTMLDialogElement>(null)
  const open = state.status !== 'authenticated'
  useEffect(() => {
    void refreshSession()
    const check = () => { if (!document.hidden) void refreshSession() }
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    const timer = window.setInterval(check, 60_000)
    return () => {
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
      window.clearInterval(timer)
    }
  }, [])
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal()
    else if (!open) dialog.current?.close()
  }, [open])
  const [callbackMessage, setCallbackMessage] = useState('Vérification de la connexion…')
  const [secondaryCallback] = useState(() => new URLSearchParams(window.location.search).get('oidc') === 'complete' && sessionStorage.getItem('sillage-oidc-secondary') === 'true')
  useEffect(() => {
    if (!secondaryCallback) return
    void completeOIDC().then(ok => {
      if (!ok) { setCallbackMessage('Connexion non confirmée. Revenez à votre onglet Sillage pour réessayer.'); return }
      sessionStorage.removeItem('sillage-oidc-secondary')
      setCallbackMessage('Connexion confirmée. Vous pouvez fermer cet onglet et revenir à Sillage.')
      window.close()
    })
  }, [secondaryCallback])
  if (secondaryCallback) return <main><p>{callbackMessage}</p></main>
  return <>
    <div className="auth-shell" inert={open} style={open ? { visibility: 'hidden' } : undefined}>
      {state.mounted && children}
    </div>
    <dialog ref={dialog} className="auth-dialog" onCancel={event => event.preventDefault()} aria-labelledby="auth-title">
      <h1 id="auth-title">{state.mounted ? 'Reconnectez-vous à Sillage' : 'Connexion à Sillage'}</h1>
      {state.mounted && <p>Votre brouillon et votre historique sont conservés dans cet onglet. Les accès au serveur sont suspendus.</p>}
      {state.status === 'loading' ? <p>Vérification de la session…</p>
        : state.status === 'unavailable' ? <><p role="alert">{state.message}</p><button className="button" onClick={() => void refreshSession()}>Réessayer</button></>
        : open ? <>{state.methods !== 'local' && <OIDCLogin secondary={state.mounted} />}{state.methods !== 'oidc' && <LoginForm />}</> : null}
    </dialog>
  </>
}

/** Présente la connexion locale avec les conventions des gestionnaires de mots de passe. */
function LoginForm() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try { await login(username, password); setPassword('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Connexion impossible.') }
    finally { setBusy(false) }
  }
  return <form onSubmit={event => void submit(event)}>
    <label htmlFor="auth-username">Identifiant</label>
    <input id="auth-username" name="username" autoComplete="username" required maxLength={128} value={username} onChange={event => setUsername(event.target.value)} />
    <label htmlFor="auth-password">Mot de passe</label>
    <input id="auth-password" name="password" type="password" autoComplete="current-password" required maxLength={1024} value={password} onChange={event => setPassword(event.target.value)} />
    {error && <p role="alert">{error}</p>}
    <button className="button" type="submit" disabled={busy}>{busy ? 'Connexion…' : 'Se connecter'}</button>
  </form>
}

/** La déconnexion volontaire demande une décision explicite avant d'abandonner un brouillon. */
export function SessionMenu() {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function leave(all: boolean) {
    if (hasPendingDraft() && !window.confirm('Des modifications ne sont pas confirmées. Se déconnecter et abandonner le brouillon de cet onglet ?')) return
    if (all && !window.confirm('Déconnecter toutes les sessions Sillage ?')) return
    setBusy(true); setError('')
    try { await logout(all) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Déconnexion impossible.') }
    finally { setBusy(false) }
  }
  return <details className="session-menu">
    <summary>Session</summary>
    <button className="button" disabled={busy} onClick={() => void leave(false)}>Se déconnecter</button>
    <button className="button" disabled={busy} onClick={() => void leave(true)}>Déconnecter toutes les sessions</button>
    {error && <p role="alert">{error}</p>}
  </details>
}

/** Ouvre la fenêtre sur le geste utilisateur pour préserver l'éditeur et limiter les blocages du navigateur. */
function OIDCLogin({ secondary }: { secondary: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fallback, setFallback] = useState('')
  async function connect() {
    if (busy) return
    const popup = secondary ? window.open('about:blank', '_blank') : null
    if (popup) {
      popup.sessionStorage.setItem('sillage-oidc-secondary', 'true')
      popup.opener = null
      popup.document.body.textContent = 'Préparation de la connexion SSO…'
    }
    setBusy(true); setError(''); setFallback('')
    try {
      const url = await startOIDC()
      if (!secondary) window.location.assign(url)
      else if (popup) popup.location.replace(url)
      else setFallback(url)
    } catch (cause) {
      popup?.close()
      setError(cause instanceof Error ? cause.message : 'Connexion SSO impossible.')
    } finally { setBusy(false) }
  }
  return <div>
    <button className="button" disabled={busy} onClick={() => void connect()}>{busy ? 'Connexion…' : 'Se connecter avec le SSO'}</button>
    {error && <p role="alert">{error}</p>}
    {fallback && <p>La fenêtre a été bloquée. <a href={fallback} target="_blank" rel="noopener noreferrer">Ouvrir la connexion dans un autre onglet</a>, puis revenez ici sans fermer cet onglet.</p>}
  </div>
}
