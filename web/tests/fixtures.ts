import { test as base, expect } from '@playwright/test'
import type { YouTubeOptions } from '../src/youtubeApi'

interface MockPlayer {
  state: number
  position: number
  destroyed: boolean
  pauseCalls: number
  iframe: HTMLIFrameElement
  options: YouTubeOptions
  pauseVideo(): void
  getPlayerState(): number
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
    destroy() { this.destroyed = true; this.state = 0; this.iframe.remove() }
    emitState(state: number) { this.state = state; this.options.events.onStateChange({ target: this, data: state }) }
  }
  window.YT = { Player }
  window.onYouTubeIframeAPIReady?.()
}

/** Interdit tout accès YouTube réel dans les scénarios navigateur, anciens compris. */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route('https://www.youtube.com/**', route => route.request().url() === 'https://www.youtube.com/iframe_api'
      ? route.fulfill({ contentType: 'application/javascript', body: `(${installYouTubeMock.toString()})()` })
      : route.abort())
    await use(page)
  },
})

export { expect }
