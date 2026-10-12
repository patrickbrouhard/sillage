import { useState } from 'react'

/** Préférence d'affichage locale ; les variables CSS préservent les sessions montées. */
export function ThemeSelector() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'system')

  function changeTheme(value: string) {
    document.documentElement.dataset.theme = value
    setTheme(value)
    // Un navigateur qui refuse le stockage doit quand même permettre le changement.
    try { localStorage.setItem('sillage.theme', value) } catch { /* Choix limité à la page courante. */ }
  }

  return <div className="theme-selector">
    <label htmlFor="display-theme">Thème</label>
    <select id="display-theme" value={theme} onChange={event => changeTheme(event.target.value)}>
      <option value="light">Clair</option>
      <option value="dark">Sombre</option>
      <option value="system">Système</option>
    </select>
  </div>
}
