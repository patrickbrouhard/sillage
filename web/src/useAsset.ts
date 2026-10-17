import { useMemo, useSyncExternalStore } from 'react'
import { getAsset } from './assetApi'
import type { Asset } from './assetApi'

interface Snapshot { asset: Asset | null; error: string }
const empty: Snapshot = { asset: null, error: '' }
const entries = new Map<number, AssetEntry>()

/** Mutualise les consultations d'une identité entre le bouton et ses occurrences Markdown. */
class AssetEntry {
  value: Snapshot = empty
  listeners = new Set<() => void>()
  controller: AbortController | null = null
  timer: ReturnType<typeof setTimeout> | undefined
  constructor(readonly id: number) {}
  snapshot = () => this.value
  publish(value: Snapshot) { this.value = value; this.listeners.forEach(listener => listener()) }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      entries.set(this.id, this)
      this.controller = new AbortController()
      void this.load(this.controller.signal)
    }
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) {
        this.controller?.abort()
        clearTimeout(this.timer)
        if (entries.get(this.id) === this) entries.delete(this.id)
      }
    }
  }
  async load(signal: AbortSignal) {
    try {
      const asset = await getAsset(this.id, signal)
      if (!signal.aborted) this.publish({ asset, error: '' })
    } catch {
      if (!signal.aborted) this.publish({ ...this.value, error: 'Impossible de consulter l’état de la capture. Nouvelle tentative en cours…' })
    }
    if (!signal.aborted && (this.value.error || this.value.asset?.status === 'pending')) {
      this.timer = setTimeout(() => void this.load(signal), 2_000)
    }
  }
}

const noopSubscribe = () => () => {}

/** Observe seulement les identités actuellement affichées, sans suivi global permanent. */
export function useAsset(id: number | null): Snapshot {
  const entry = useMemo(() => {
    if (id === null) return null
    let value = entries.get(id)
    if (!value) { value = new AssetEntry(id); entries.set(id, value) }
    return value
  }, [id])
  return useSyncExternalStore(entry?.subscribe ?? noopSubscribe, entry?.snapshot ?? (() => empty))
}
