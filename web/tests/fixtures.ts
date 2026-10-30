import { readFile } from 'node:fs/promises'
import { test as base, expect } from '@playwright/test'
import type { YouTubeOptions } from '../src/youtubeApi'

interface MockPlayer {
  state: number
  position: number
  destroyed: boolean
  pauseCalls: number
  navigationCalls: { command: 'seek' | 'cue'; seconds: number; videoId?: string; allowSeekAhead?: boolean }[]
  seekTo(seconds: number, allowSeekAhead: boolean): void
  cueVideoById(options: { videoId: string; startSeconds: number }): void
  iframe: HTMLIFrameElement
  options: YouTubeOptions
  pauseVideo(): void
  getPlayerState(): number
  getCurrentTime(): number
  getDuration(): number
  getPlaybackRate(): number
  destroy(): void
  emitState(state: number): void
}

declare global {
  interface Window {
    youtubeTest: {
      players: MockPlayer[]
      autoReady: boolean
      confirmPause: boolean
    }
  }
}

/** Fournit une API contrôlable tout en laissant le chargement du script traverser le client réel. */
function installYouTubeMock() {
  window.youtubeTest ??= { players: [], autoReady: true, confirmPause: true }
  class Player implements MockPlayer {
    state = -1
    position = 0
    destroyed = false
    pauseCalls = 0
    navigationCalls: MockPlayer['navigationCalls'] = []
    constructor(public iframe: HTMLIFrameElement, public options: YouTubeOptions) {
      iframe.src = 'about:blank'
      window.youtubeTest.players.push(this)
      if (window.youtubeTest.autoReady) window.setTimeout(() => options.events.onReady({ target: this }), 0)
    }
    pauseVideo() {
      this.pauseCalls++
      if (window.youtubeTest.confirmPause) this.emitState(2)
    }
    getPlayerState() { return this.state }
    getCurrentTime() { return this.position }
    getDuration() { return 120 }
    getPlaybackRate() { return 1 }
    /** Reproduit le démarrage réel de seekTo hors de l'état paused. */
    seekTo(seconds: number, allowSeekAhead: boolean) {
      this.navigationCalls.push({ command: 'seek', seconds, allowSeekAhead })
      this.position = seconds
      this.emitState(this.state === 2 ? 2 : 1)
    }
    /** Prépare uniquement le départ, sans simuler une lecture. */
    cueVideoById({ videoId, startSeconds }: { videoId: string; startSeconds: number }) {
      this.navigationCalls.push({ command: 'cue', seconds: startSeconds, videoId })
      this.position = startSeconds
      this.emitState(5)
    }
    destroy() { this.destroyed = true; this.state = 0; this.iframe.remove() }
    emitState(state: number) { this.state = state; this.options.events.onStateChange({ target: this, data: state }) }
  }
  window.YT = { Player }
  window.onYouTubeIframeAPIReady?.()
}

/** Interdit tout accès YouTube réel dans les scénarios navigateur, anciens compris. */
export const test = base.extend({
  request: async ({ playwright, baseURL }, use) => {
    const request = await playwright.request.newContext({
      baseURL, storageState: 'tests/.auth/state.json',
      extraHTTPHeaders: { 'X-CSRF-Token': (await readFile('tests/.auth/csrf.txt', 'utf8')).trim() },
    })
    await use(request)
    await request.dispose()
  },
  page: async ({ page }, use) => {
    await page.route('https://www.youtube.com/**', route => route.request().url() === 'https://www.youtube.com/iframe_api'
      ? route.fulfill({ contentType: 'application/javascript', body: `(${installYouTubeMock.toString()})()` })
      : route.abort())
    await use(page)
  },
})

export { expect }
