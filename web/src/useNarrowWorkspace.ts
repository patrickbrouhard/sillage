import { useEffect, useState } from 'react'

/** Suit le même seuil que la grille, sans remplacer ses composants. */
export function useNarrowWorkspace() {
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1099px)').matches)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1099px)')
    const change = () => setNarrow(query.matches)
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [])
  return narrow
}

