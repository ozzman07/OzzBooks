import sharp from 'sharp'
import { mkdirSync } from 'node:fs'

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#1E293B"/>
  <path d="M160 128c0-17.7 14.3-32 32-32h32c17.7 0 32 14.3 32 32v256c0 17.7-14.3 32-32 32h-32c-17.7 0-32-14.3-32-32V128z" fill="#F59E0B"/>
  <path d="M256 160c0-17.7 14.3-32 32-32h32c17.7 0 32 14.3 32 32v192c0 17.7-14.3 32-32 32h-32c-17.7 0-32-14.3-32-32V160z" fill="#FBBF24"/>
  <circle cx="176" cy="160" r="10" fill="#1E293B"/>
  <circle cx="176" cy="224" r="10" fill="#1E293B"/>
  <circle cx="176" cy="288" r="10" fill="#1E293B"/>
</svg>
`

mkdirSync('public/icons', { recursive: true })

const sizes = [192, 512]
for (const size of sizes) {
  await sharp(Buffer.from(svg))
    .resize(size, size)
    .png()
    .toFile(`public/icons/icon-${size}.png`)
}

// maskable icon: same art, more padding so safe-zone cropping doesn't clip it
const maskableSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#1E293B"/>
  <g transform="translate(96 96) scale(0.625)">
    <path d="M160 128c0-17.7 14.3-32 32-32h32c17.7 0 32 14.3 32 32v256c0 17.7-14.3 32-32 32h-32c-17.7 0-32-14.3-32-32V128z" fill="#F59E0B"/>
    <path d="M256 160c0-17.7 14.3-32 32-32h32c17.7 0 32 14.3 32 32v192c0 17.7-14.3 32-32 32h-32c-17.7 0-32-14.3-32-32V160z" fill="#FBBF24"/>
    <circle cx="176" cy="160" r="10" fill="#1E293B"/>
    <circle cx="176" cy="224" r="10" fill="#1E293B"/>
    <circle cx="176" cy="288" r="10" fill="#1E293B"/>
  </g>
</svg>
`
await sharp(Buffer.from(maskableSvg))
  .resize(512, 512)
  .png()
  .toFile('public/icons/icon-maskable-512.png')

await sharp(Buffer.from(svg))
  .resize(180, 180)
  .png()
  .toFile('public/apple-touch-icon.png')

console.log('Icons generated.')
