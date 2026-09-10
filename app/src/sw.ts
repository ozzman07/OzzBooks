/// <reference lib="webworker" />
export {}
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>
}

import { precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'
import { matchOfflineAudioPath, buildOfflineAudioResponse } from './offline/offlineAudioRange'

// generateSW mode wires this listener into its output automatically;
// injectManifest mode (this file) does not — without it,
// UpdatePrompt.tsx's "Update" button (which calls updateServiceWorker(true)
// from virtual:pwa-register/react, which postMessages this exact shape to
// the waiting worker) would silently do nothing.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})

// Range-request serving for downloaded audiobooks — see offlineAudioRange.ts
// for why this exists (avoids handing <audio> one giant Blob URL, which
// causes silent, unrecoverable stalls on memory-constrained iOS devices for
// large books). Registered before precacheAndRoute so it takes priority.
registerRoute(
  ({ url, request }) => request.method === 'GET' && matchOfflineAudioPath(url.pathname) !== null,
  async ({ url, request }) =>
    buildOfflineAudioResponse(matchOfflineAudioPath(url.pathname)!, request.headers.get('Range')),
)

// Precaches the build's static assets — replaces generateSW's automatic
// precaching behavior now that this is a hand-written service worker.
precacheAndRoute(self.__WB_MANIFEST)

// Replaces the old workbox.navigateFallbackDenylist (a generateSW-only
// option): without this denylist, the SPA fallback would intercept the
// Google Drive OAuth flow's full-page redirect to
// /api/sources/oauth/google/start and serve cached index.html instead of
// letting it reach the server, silently breaking the OAuth flow.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api\//],
  }),
)
