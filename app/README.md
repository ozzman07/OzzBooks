# OzzBooks frontend

PWA frontend. See `../Claude.md` for the full project spec, architecture, and
roadmap.

Talks to two real backends — no more mock data:
- `../server` — the file-serving API (library metadata, audio streaming)
- `../cloud` — the sync/auth layer (accounts, playback position, bookmarks)

Copy `.env.example` to `.env.local` and point both `VITE_API_BASE_URL`
and `VITE_CLOUD_API_BASE_URL` at running instances for local dev
(`npm run dev` in each of `../server` and `../cloud`).

## Develop

```bash
npm install
npm run dev
```

`public/icons/` (placeholder app icons, via `scripts/gen-icons.mjs`) is
committed since the manifest needs them to resolve at build time; rerun
that script if you replace them with real artwork.

## Build

```bash
npm run build
```

In production, the API token is baked into the build via `VITE_API_TOKEN`
at build time (see `.env.example`) — anyone who can reach the built PWA
can read it out of the bundle, so it's only defense-in-depth alongside
Tailscale network gating, same as on the server side. Don't reuse it as a
secret anywhere else.
