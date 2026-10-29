/** État partagé sans secret persistant côté navigateur. */
export interface AuthState {
  status: 'loading' | 'authenticated' | 'locked' | 'anonymous' | 'unavailable'
  methods: 'local' | 'both' | 'oidc'
  mounted: boolean
  csrf: string
  message: string
}

let state: AuthState = { status: 'loading', methods: 'local', mounted: false, csrf: '', message: '' }
const listeners = new Set<() => void>()
const pendingNotes = new Set<() => boolean>()
let epoch = 0
let refreshing: Promise<void> | null = null
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('sillage-auth')

function publish(change: Partial<AuthState>) {
  state = { ...state, ...change }
  listeners.forEach(listener => listener())
}

/** Fournit une référence stable à React et aux sessions de notes. */
export const authSnapshot = () => state
/** Observe la connexion sans remonter l'éditeur. */
export function subscribeAuth(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
/** Registre temporaire des brouillons à protéger avant une déconnexion volontaire. */
export function protectDraft(check: () => boolean) {
  pendingNotes.add(check)
  return () => { pendingNotes.delete(check) }
}
/** Signale si une confirmation de perte est nécessaire. */
export const hasPendingDraft = () => [...pendingNotes].some(check => check())
/** Vérifie l'état courant avant de programmer une requête privée. */
export const isAuthenticated = () => state.status === 'authenticated'

/** Distingue une suspension d'accès d'un résultat d'écriture incertain. */
export class AuthenticationError extends Error {
  constructor() { super('Connexion requise. Votre travail reste conservé dans cet onglet.') }
}

function lock() {
  publish({ status: state.mounted ? 'locked' : 'anonymous', message: '' })
}

/** Relit le serveur ; une panne réseau ne prétend jamais que la session est révoquée. */
export function refreshSession(): Promise<void> {
  if (refreshing) return refreshing
  const generation = epoch
  refreshing = (async () => {
    try {
      const response = await fetch('/api/v1/auth/session', { cache: 'no-store', credentials: 'same-origin' })
      if (!response.ok) throw new Error()
      const body = await response.json()
      if (typeof body.authenticated !== 'boolean' || typeof body.csrf_token !== 'string') throw new Error()
      if (generation !== epoch) return
      publish({ methods: body.methods === 'oidc' || body.methods === 'both' ? body.methods : 'local', csrf: body.csrf_token, message: '', mounted: state.mounted || body.authenticated,
        status: body.authenticated ? 'authenticated' : state.mounted ? 'locked' : 'anonymous' })
    } catch {
      if (generation === epoch) publish({ status: 'unavailable', message: 'Connexion au serveur impossible. Votre travail reste dans cet onglet.' })
    } finally { refreshing = null }
  })()
  return refreshing
}

/** Connecte le propriétaire sans redirection ni remplacement de la session d'édition. */
export async function login(username: string, password: string): Promise<void> {
  await refreshSession()
  const response = await fetch('/api/v1/auth/login', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf },
    body: JSON.stringify({ username, password }),
  })
  if (!response.ok) {
    if (response.status === 401) throw new Error('Identifiant ou mot de passe incorrect.')
    if (response.status === 429) throw new Error('Trop de tentatives. Patientez puis réessayez.')
    throw new Error('Connexion impossible. Réessayez.')
  }
  const body = await response.json()
  epoch++
  publish({ status: 'authenticated', mounted: true, csrf: body.csrf_token, message: '' })
  channel?.postMessage('refresh')
}

/** Déconnecte après décision explicite sur les brouillons ; les autres onglets restent verrouillés. */
export async function logout(all = false): Promise<void> {
  const response = await apiFetch('/api/v1/auth/' + (all ? 'logout-all' : 'logout'), { method: 'POST' })
  if (!response.ok) throw new Error('Déconnexion non confirmée. Réessayez.')
  epoch++
  publish({ status: 'anonymous', mounted: false, csrf: '', message: '' })
  channel?.postMessage('lock')
  await refreshSession()
}

if (channel) channel.onmessage = event => {
  if (event.data === 'lock') { epoch++; lock() }
  void refreshSession()
}

/** Ajoute le CSRF et suspend les accès ; aucune mutation n'est rejouée implicitement. */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  if (!isAuthenticated()) throw new AuthenticationError()
  const generation = epoch
  const headers = new Headers(init.headers)
  const method = (init.method ?? 'GET').toUpperCase()
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('X-CSRF-Token', state.csrf)
  const response = await fetch(input, { ...init, headers, credentials: 'same-origin' })
  if (response.status === 401) {
    if (generation === epoch) lock()
    throw new AuthenticationError()
  }
  if (response.status === 403 && (await response.clone().json().catch(() => null))?.error?.code === 'csrf_invalid') {
    if (generation === epoch) { lock(); void refreshSession() }
    throw new AuthenticationError()
  }
  return response
}

/** Prépare une connexion explicite ; aucune redirection automatique ne suit une déconnexion. */
export async function startOIDC(): Promise<string> {
  await refreshSession()
  const response = await fetch('/api/v1/auth/oidc/start', {
    method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': state.csrf },
  })
  if (!response.ok) throw new Error('Connexion SSO indisponible. Réessayez sans fermer cet onglet.')
  const body = await response.json()
  if (typeof body.url !== 'string' || !body.url.startsWith('https://')) throw new Error('Réponse SSO invalide.')
  return body.url
}

/** Une notification invite à relire le serveur ; elle ne constitue jamais une preuve de connexion. */
export async function completeOIDC(): Promise<boolean> {
  await refreshSession()
  if (!isAuthenticated()) return false
  channel?.postMessage('refresh')
  return true
}
