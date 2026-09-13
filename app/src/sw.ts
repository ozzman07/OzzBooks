/// <reference lib="webworker" />
export {}
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>
}

import { precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'

// generateSW mode wires this listener into its output automatically;
// injectManifest mode (this file) does not — without it,
// UpdatePrompt.tsx's "Update" button (which calls updateServiceWorker(true)
// from virtual:pwa-register/react, which postMessages this exact shape to
// the waiting worker) would silently do nothing.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})

// --- TEMPORARY: offline-audio spike test route --------------------------
// Tests only the chunked-storage capped-Range-response mechanism from the
// redesign plan (see src/pages/SpikeTest.tsx). Reads only from Cache
// Storage, deliberately never IndexedDB. Remove this whole block, and
// revert vite.config.ts back to generateSW, once validated (unless the
// full redesign has landed by then, which will replace it with the real
// thing anyway).
const SPIKE_CHUNK_CACHE = 'spike-chunks-v1'
const SPIKE_AUDIO_PATH = '/spike-audio'
const SPIKE_MAX_SERVED_CHUNKS = 4 // ~32MB cap per response with an 8MB chunk size

function spikeLog(msg: string): void {
  void self.clients.matchAll().then((clients) => {
    for (const c of clients) c.postMessage({ type: 'spike-log', msg })
  })
}

async function getSpikeManifest(): Promise<{ totalSize: number; chunkSize: number; chunkCount: number; mimeType: string } | null> {
  const cache = await caches.open(SPIKE_CHUNK_CACHE)
  const res = await cache.match('/spike-manifest')
  if (!res) return null
  return res.json()
}

type SpikeRange = { kind: 'none' } | { kind: 'satisfiable'; start: number; end: number } | { kind: 'unsatisfiable' }

function parseSpikeRange(rangeHeader: string | null, totalSize: number): SpikeRange {
  if (!rangeHeader) return { kind: 'none' }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!match) return { kind: 'none' }
  const [, startStr, endStr] = match
  if (startStr === '' && endStr === '') return { kind: 'none' }
  if (totalSize === 0) return { kind: 'unsatisfiable' }
  let start: number
  let end: number
  if (startStr === '') {
    const suffixLength = Number(endStr)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { kind: 'unsatisfiable' }
    start = Math.max(0, totalSize - suffixLength)
    end = totalSize - 1
  } else {
    start = Number(startStr)
    end = endStr === '' ? totalSize - 1 : Number(endStr)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= totalSize || start > end) {
    return { kind: 'unsatisfiable' }
  }
  return { kind: 'satisfiable', start, end: Math.min(end, totalSize - 1) }
}

async function buildSpikeAudioResponse(rangeHeader: string | null): Promise<Response> {
  const manifest = await getSpikeManifest()
  if (!manifest) {
    spikeLog('404: no manifest yet')
    return new Response(null, { status: 404 })
  }
  const { totalSize, chunkSize, mimeType } = manifest
  const range = parseSpikeRange(rangeHeader, totalSize)

  if (range.kind === 'unsatisfiable') {
    spikeLog('416 unsatisfiable range: ' + rangeHeader)
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${totalSize}` } })
  }

  const start = range.kind === 'satisfiable' ? range.start : 0
  const requestedEnd = range.kind === 'satisfiable' ? range.end : totalSize - 1
  const cappedEnd = Math.min(requestedEnd, start + SPIKE_MAX_SERVED_CHUNKS * chunkSize - 1, totalSize - 1)

  const firstChunk = Math.floor(start / chunkSize)
  const lastChunk = Math.floor(cappedEnd / chunkSize)
  const cache = await caches.open(SPIKE_CHUNK_CACHE)
  const parts: Blob[] = []
  for (let i = firstChunk; i <= lastChunk; i++) {
    const chunkRes = await cache.match(`/spike-chunk/${i}`)
    if (!chunkRes) {
      spikeLog('500: missing chunk ' + i)
      return new Response(null, { status: 500 })
    }
    const chunkBlob = await chunkRes.blob()
    const sliceStart = i === firstChunk ? start - i * chunkSize : 0
    const sliceEnd = i === lastChunk ? cappedEnd - i * chunkSize + 1 : chunkBlob.size
    parts.push(chunkBlob.slice(sliceStart, sliceEnd))
  }
  const body = new Blob(parts, { type: mimeType })
  const isFullBody = range.kind === 'none' && cappedEnd === totalSize - 1
  const status = isFullBody ? 200 : 206
  const headers: Record<string, string> = {
    'Content-Type': mimeType,
    'Content-Length': String(body.size),
    'Accept-Ranges': 'bytes',
  }
  if (!isFullBody) headers['Content-Range'] = `bytes ${start}-${cappedEnd}/${totalSize}`
  spikeLog(
    `${status} served ${(body.size / 1e6).toFixed(1)}MB ` +
      `(requested ${rangeHeader || 'no-range'}, chunks ${firstChunk}-${lastChunk} of ${manifest.chunkCount})`,
  )
  return new Response(body, { status, headers })
}

registerRoute(
  ({ url, request }) => url.pathname === SPIKE_AUDIO_PATH && request.method === 'GET',
  async ({ request }) => buildSpikeAudioResponse(request.headers.get('Range')),
)
// --- end TEMPORARY spike route -------------------------------------------

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
