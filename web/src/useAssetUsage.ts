import { useEffect, useRef, useState } from 'react'
import { countAssetImages } from './assetUsage'
import type { NoteSession, NoteSnapshot } from './noteSession'

const empty: ReadonlyMap<number, number> = new Map()

/** Regroupe les frappes sans analyser le Markdown dans le rendu ni publier une ancienne version. */
export function useAssetUsage(session: NoteSession, note: NoteSnapshot) {
  const [result, setResult] = useState({ content: '', version: -1, counts: empty })
  const pendingSince = useRef<number | null>(null)
  const { content, editorVersion } = note

  useEffect(() => {
    pendingSince.current ??= Date.now()
    // Le délai court regroupe les rafales ; le plafond conserve un suivi pendant une frappe continue.
    const delay = Math.min(250, Math.max(0, 1000 - (Date.now() - pendingSince.current)))
    const timer = window.setTimeout(() => {
      const current = session.snapshot()
      if (current.content !== content || current.editorVersion !== editorVersion) return
      const counts = countAssetImages(content)
      // Le résultat appartient au contenu exact, pas à une révision confirmée ni à un compteur d'actions.
      if (session.snapshot().content !== content || session.snapshot().editorVersion !== editorVersion) return
      pendingSince.current = null
      setResult({ content, version: editorVersion, counts })
    }, delay)
    return () => window.clearTimeout(timer)
  }, [session, content, editorVersion])

  return {
    // Une version explicitement remplacée ne doit jamais présenter les compteurs de l'ancienne session.
    counts: result.version === editorVersion ? result.counts : empty,
    pending: result.version !== editorVersion || result.content !== content,
  }
}
