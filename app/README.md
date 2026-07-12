# OzzBooks frontend

PWA frontend. See `../Claude.md` for the full project spec, architecture, and
roadmap.

Currently running against mock in-memory data (`src/data/mockBooks.ts`) —
no backend yet.

## Develop

```bash
npm install
node scripts/gen-demo-audio.mjs   # one-time: generate placeholder audio for local playback testing
npm run dev
```

`public/audio/` (placeholder demo audio) is gitignored/generated —
regenerate it after a fresh clone if you want working local playback.
`public/icons/` (placeholder app icons, via `scripts/gen-icons.mjs`) is
committed since the manifest needs them to resolve at build time; rerun
that script if you replace them with real artwork.

## Build

```bash
npm run build
```
