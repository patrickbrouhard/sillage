// Appliquer le choix avant le premier rendu évite un éclair clair au rechargement.
// Le CSS suit lui-même le système, sans abonnement JavaScript ni remontage React.
try {
  const saved = localStorage.getItem('sillage.theme')
  document.documentElement.dataset.theme = ['light', 'dark'].includes(saved) ? saved : 'system'
} catch {
  document.documentElement.dataset.theme = 'system'
}
