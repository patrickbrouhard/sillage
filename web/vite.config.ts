import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // Préserver Host et Origin : le backend attend l’origine publique Vite.
      '^/mcp(?:[/?]|$)': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: false,
      },
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: false,
      },
    },
  },
})
