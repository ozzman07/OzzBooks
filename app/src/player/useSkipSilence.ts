import { useEffect, useRef } from 'react'

const SILENCE_RMS_THRESHOLD = 0.015
const SILENCE_TRIGGER_MS = 500
const SKIP_STEP_SECONDS = 0.15

/**
 * Fast-forwards through sustained quiet stretches by nudging currentTime
 * forward in small steps while measured RMS volume stays below threshold —
 * gentle enough to not jump past the start of the next word.
 */
export function useSkipSilence(audioRef: React.RefObject<HTMLAudioElement | null>, enabled: boolean) {
  const graphRef = useRef<{
    context: AudioContext
    analyser: AnalyserNode
    source: MediaElementAudioSourceNode
  } | null>(null)

  useEffect(() => {
    if (!enabled) return
    const audio = audioRef.current
    if (!audio) return

    if (!graphRef.current) {
      const context = new AudioContext()
      const source = context.createMediaElementSource(audio)
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      analyser.connect(context.destination)
      graphRef.current = { context, analyser, source }
    }

    const { context, analyser } = graphRef.current
    if (context.state === 'suspended') context.resume()

    const data = new Float32Array(analyser.fftSize)
    let silenceStartedAt: number | null = null
    let rafId: number

    const tick = () => {
      analyser.getFloatTimeDomainData(data)
      let sumSquares = 0
      for (let i = 0; i < data.length; i++) sumSquares += data[i] * data[i]
      const rms = Math.sqrt(sumSquares / data.length)

      if (rms < SILENCE_RMS_THRESHOLD && !audio.paused) {
        if (silenceStartedAt === null) silenceStartedAt = performance.now()
        else if (performance.now() - silenceStartedAt > SILENCE_TRIGGER_MS) {
          audio.currentTime = Math.min(audio.currentTime + SKIP_STEP_SECONDS, audio.duration || Infinity)
        }
      } else {
        silenceStartedAt = null
      }

      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    return () => cancelAnimationFrame(rafId)
  }, [enabled, audioRef])

  // Tear down the audio graph entirely if the feature is turned back off,
  // so we're not running analysis in the background for no reason.
  useEffect(() => {
    if (enabled || !graphRef.current) return
    const { context } = graphRef.current
    context.suspend()
  }, [enabled])
}
