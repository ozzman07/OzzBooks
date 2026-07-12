// Generates a short placeholder WAV so playback can be exercised locally
// during development. Not real book audio — that comes from ingestion.
// Output is gitignored; regenerate with `node scripts/gen-demo-audio.mjs`.
import { mkdirSync, writeFileSync } from 'node:fs'

const sampleRate = 22050
const seconds = 30
const numSamples = sampleRate * seconds
const freq = 220 // A3, easy on the ears for a dev placeholder

const dataSize = numSamples * 2 // 16-bit mono
const buffer = Buffer.alloc(44 + dataSize)

buffer.write('RIFF', 0)
buffer.writeUInt32LE(36 + dataSize, 4)
buffer.write('WAVE', 8)
buffer.write('fmt ', 12)
buffer.writeUInt32LE(16, 16)
buffer.writeUInt16LE(1, 20) // PCM
buffer.writeUInt16LE(1, 22) // mono
buffer.writeUInt32LE(sampleRate, 24)
buffer.writeUInt32LE(sampleRate * 2, 28) // byte rate
buffer.writeUInt16LE(2, 32) // block align
buffer.writeUInt16LE(16, 34) // bits per sample
buffer.write('data', 36)
buffer.writeUInt32LE(dataSize, 40)

const fadeSamples = sampleRate * 0.05
// Quiet stretch from 10s-14s so skip-silence has something to demonstrate on.
const silenceStart = sampleRate * 10
const silenceEnd = sampleRate * 14
for (let i = 0; i < numSamples; i++) {
  const t = i / sampleRate
  let amplitude = i >= silenceStart && i < silenceEnd ? 0.001 : 0.15
  if (i < fadeSamples) amplitude *= i / fadeSamples
  if (i > numSamples - fadeSamples) amplitude *= (numSamples - i) / fadeSamples
  const sample = Math.sin(2 * Math.PI * freq * t) * amplitude * 32767
  buffer.writeInt16LE(Math.round(sample), 44 + i * 2)
}

mkdirSync('public/audio', { recursive: true })
writeFileSync('public/audio/demo-chapter.wav', buffer)
console.log('Wrote public/audio/demo-chapter.wav')
