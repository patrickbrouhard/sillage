import { useEffect, useRef, useState } from 'react'
import { apiFetch, authSnapshot, authEpoch, isAuthenticated, subscribeAuth } from './auth'

interface Key { id: string; name: string; permission: string; created_at: string; expires_at: string | null; revoked_at: string | null }

/** Gère les accès MCP ; le secret éphémère ne rejoint aucun stockage navigateur. */
export function APIKeys() {
 const [keys, setKeys] = useState<Key[]>([])
 const [name, setName] = useState('')
 const [expiration, setExpiration] = useState('')
 const [never, setNever] = useState(false)
 const [secret, setSecret] = useState('')
 const [error, setError] = useState('')
 const [busy, setBusy] = useState(false)
 const pending = useRef(false)
 const alive = useRef(true)
 const generation = useRef(0)
 async function refresh() {
  const response = await apiFetch('/api/v1/api-keys', { cache: 'no-store' })
  if (!response.ok) throw new Error('Liste indisponible.')
  const data = await response.json()
  if (alive.current && isAuthenticated()) setKeys(data)
 }
 useEffect(() => {
  alive.current = true
  void refresh().catch(() => setError('Impossible de charger les clés.'))
  let previous = authSnapshot()
  let previousEpoch = authEpoch()
  const unsubscribe = subscribeAuth(() => {
   const next = authSnapshot()
   const nextEpoch = authEpoch()
   // Le CSRF est stable pour un cookie donné : il détecte aussi un remplacement
   // de session depuis un autre onglet, sans exposer le cookie HttpOnly.
   if (next.status !== 'authenticated' || next.csrf !== previous.csrf || nextEpoch !== previousEpoch) {
    generation.current++
    setSecret('')
   }
   previous = next
   previousEpoch = nextEpoch
  })
  return () => { alive.current = false; generation.current++; unsubscribe() }
 }, [])
 async function mutate(action: 'create' | 'revoke' | 'all', id?: string) {
  if (pending.current) return
  if (action !== 'create' && !window.confirm(action === 'all' ? 'Révoquer toutes les clés API ? Les sessions Web resteront ouvertes.' : 'Révoquer cette clé API ?')) return
  pending.current = true; setBusy(true); setError(''); setSecret('')
  const epoch = authEpoch(); const current = generation.current
  try {
   const path = action === 'create' ? '' : action === 'all' ? '/revoke-all' : '/' + id
   const response = await apiFetch('/api/v1/api-keys' + path, {
    method: action === 'revoke' ? 'DELETE' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: action === 'create' ? JSON.stringify({ name, expires_at: never ? null : new Date(expiration).toISOString() }) : undefined,
   })
   if (!response.ok) throw new Error('Opération non confirmée.')
   if (action === 'create') {
    const data = await response.json()
    // Une reconnexion ou un verrouillage invalide aussi une réponse HTTP réussie.
    if (alive.current && isAuthenticated() && epoch === authEpoch() && current === generation.current) { setSecret(data.secret); setName('') }
   }
   await refresh()
  } catch {
   if (alive.current) setError('Résultat non confirmé. Actualisez la liste avant de réessayer. Si une clé a été créée sans que vous receviez son secret, révoquez-la puis créez-en une nouvelle.')
  } finally { pending.current = false; if (alive.current) setBusy(false) }
 }
 return <section className="tag-catalog api-keys-page">
  <title>Clés API · Sillage</title>
  <h1>Clés API</h1>
  <p>Accès aux quatre outils MCP en lecture seule sur toute la bibliothèque. Ces clés ne permettent pas d’utiliser REST ou d’administrer Sillage.</p>
  <form onSubmit={event => { event.preventDefault(); void mutate('create') }}>
   <label>Nom de l’intégration <input required maxLength={128} value={name} onChange={event => setName(event.target.value)} /></label>
   <label>Expiration <input type="datetime-local" required={!never} disabled={never} value={expiration} onChange={event => setExpiration(event.target.value)} /></label>
   <label className="api-key-no-expiration"><input type="checkbox" checked={never} onChange={event => setNever(event.target.checked)} /> Sans expiration</label>
   <button className="button" disabled={busy}>Créer une clé</button>
  </form>
  {secret && <div className="notice"><p>Copiez ce secret maintenant. Il ne sera plus consultable après fermeture de cet encart.</p><code>{secret}</code><div>
   <button className="button" onClick={() => void navigator.clipboard.writeText(secret).catch(() => setError('Copie impossible : sélectionnez le secret pour le copier manuellement.'))}>Copier</button>
   <button className="button" onClick={() => setSecret('')}>Fermer le secret</button>
  </div></div>}
  {error && <p role="alert">{error}</p>}
  <button className="button" disabled={busy} onClick={() => void refresh().then(() => setError('')).catch(() => setError('Liste indisponible.'))}>Actualiser</button>
  <ul className="tag-catalog-list">{keys.map(key => <li key={key.id} className="tag-catalog-row"><div>
   <strong>{key.name}</strong><p>{key.permission} · {key.id}</p>
   <p>Création : {new Date(key.created_at).toLocaleString()} · Expiration : {key.expires_at ? new Date(key.expires_at).toLocaleString() : 'aucune'}</p>
   <p>{key.revoked_at ? 'Révoquée' : key.expires_at && Date.parse(key.expires_at) <= Date.now() ? 'Expirée' : 'Active'}</p>
  </div><button className="button danger" disabled={busy || Boolean(key.revoked_at)} onClick={() => void mutate('revoke',key.id)}>Révoquer</button></li>)}</ul>
  <button className="button danger" disabled={busy || !keys.some(key => !key.revoked_at)} onClick={() => void mutate('all')}>Révoquer toutes les clés</button>
 </section>
}
