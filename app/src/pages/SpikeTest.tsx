import { useCallback, useEffect, useRef, useState } from 'react'

// TEMPORARY — throwaway spike test for the offline-audio redesign plan.
// Tests ONLY the service worker's chunked Cache Storage Range-serving
// mechanism (capped multi-chunk responses) against a large synthetic file,
// on the real device, before building the full feature. Remove this page,
// its route in App.tsx, the spike route in sw.ts, and public/spike-source.wav
// once validated.

const CHUNK_SIZE = 8 * 1024 * 1024
const CHUNK_CACHE = 'spike-chunks-v1'
const SOURCE_URL = '/spike-source.wav'
const AUDIO_URL = '/spike-audio'

export function SpikeTest() {
  const [status, setStatus] = useState('not chunked yet')
  const [log, setLog] = useState<string[]>([])
  const audioRef = useRef<HTMLAudioElement>(null)
  const logRef = useRef<HTMLPreElement>(null)

  const appendLog = useCallback((msg: string) => {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`
    setLog((prev) => [...prev, line])
    // eslint-disable-next-line no-console
    console.log(line)
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight)
  }, [log])

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data && e.data.type === 'spike-log') appendLog('[sw] ' + e.data.msg)
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [appendLog])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const events = ['playing', 'waiting', 'stalled', 'error', 'pause', 'ended'] as const
    const handler = (e: Event) => appendLog('audio event: ' + e.type)
    events.forEach((evt) => audio.addEventListener(evt, handler))
    return () => events.forEach((evt) => audio.removeEventListener(evt, handler))
  }, [appendLog])

  useEffect(() => {
    if (!navigator.serviceWorker.controller) {
      appendLog('page not yet controlled by the service worker — this is expected on first load after an update')
    } else {
      appendLog('service worker controller: ' + navigator.serviceWorker.controller.scriptURL)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function headSize(url: string): Promise<number> {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' } })
    const cr = res.headers.get('content-range')
    return cr ? Number(cr.split('/')[1]) : Number(res.headers.get('content-length'))
  }

  const chunkFile = useCallback(async () => {
    try {
      const totalSize = await headSize(SOURCE_URL)
      const chunkCount = Math.ceil(totalSize / CHUNK_SIZE)
      appendLog(`source file is ${(totalSize / 1e6).toFixed(1)}MB, ${chunkCount} chunks`)

      const cache = await caches.open(CHUNK_CACHE)
      for (let i = 0; i < chunkCount; i++) {
        const start = i * CHUNK_SIZE
        const end = Math.min(start + CHUNK_SIZE, totalSize) - 1
        const res = await fetch(SOURCE_URL, { headers: { Range: `bytes=${start}-${end}` } })
        const blob = await res.blob()
        await cache.put(`/spike-chunk/${i}`, new Response(blob))
        setStatus(`chunking ${i + 1}/${chunkCount} (${(((i + 1) / chunkCount) * 100).toFixed(0)}%)`)
        if (i % 10 === 0) appendLog(`wrote chunk ${i}/${chunkCount}`)
      }

      const manifest = { totalSize, chunkSize: CHUNK_SIZE, chunkCount, mimeType: 'audio/wav' }
      await cache.put('/spike-manifest', new Response(JSON.stringify(manifest)))
      setStatus('chunked and ready — press play / use seek buttons')
      appendLog('manifest written: ' + JSON.stringify(manifest))

      if (audioRef.current) audioRef.current.src = AUDIO_URL
    } catch (e) {
      appendLog('ERROR chunking: ' + String(e))
    }
  }, [appendLog])

  const seekTo = useCallback(
    (pct: number) => {
      const audio = audioRef.current
      if (!audio || !audio.duration) {
        appendLog('no duration yet — chunk the file and let it load metadata first')
        return
      }
      const target = (pct / 100) * audio.duration
      appendLog(`seeking to ${pct}% = ${target.toFixed(0)}s`)
      audio.currentTime = target
      audio.play().catch((e) => appendLog('play() rejected: ' + e.message))
    },
    [appendLog],
  )

  return (
    <div className="mx-auto max-w-xl px-4 pb-24 pt-6 text-primary">
      <h1 className="text-lg font-semibold">Offline Audio Spike Test (temporary)</h1>
      <p className="mt-2 text-sm text-muted">
        Throwaway test — not a real feature. Tests only the chunked-storage Range-serving mechanism against an
        ~830MB synthetic file (same scale as Turn Coat).
      </p>

      <div className="mt-4">
        <div className="font-semibold">Status: {status}</div>
        <button
          className="mt-2 rounded-lg bg-amber-400 px-4 py-2 text-sm font-medium text-slate-950"
          onClick={() => void chunkFile()}
        >
          1. Chunk the file into Cache Storage
        </button>
      </div>

      <audio ref={audioRef} controls preload="none" className="mt-4 w-full" />

      <div className="mt-4 flex flex-wrap gap-2">
        {[0, 10, 25, 50, 75, 95].map((pct) => (
          <button
            key={pct}
            className="rounded-lg border border-border-strong px-3 py-1.5 text-sm"
            onClick={() => seekTo(pct)}
          >
            Seek {pct}%
          </button>
        ))}
      </div>

      <pre
        ref={logRef}
        className="mt-4 h-60 overflow-y-scroll rounded-lg bg-slate-950 p-2 text-[11px] leading-tight text-green-400"
      >
        {log.join('\n')}
      </pre>
    </div>
  )
}
