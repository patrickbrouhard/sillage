import { useEffect, useState } from 'react'
import { errorMessage, listTags } from './api'
import type { Tag } from './api'

/** Relit le catalogue à l'ouverture sans effacer les données en cas d'échec. */
export function useTagCatalog(enabled = true) {
  const [tags, setTags] = useState<Tag[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    setLoading(true)
    setError('')
    void listTags(controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setTags(result)
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason))
      },
    ).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [enabled, attempt])

  return { tags, loading, error, refresh: () => setAttempt((value) => value + 1) }
}
