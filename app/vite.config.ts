import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Baked in at build time so a running instance can be identified with
// certainty instead of guessing whether an update actually landed — see
// Settings.tsx's footer. Falls back to 'unknown' rather than failing the
// build if git isn't available for some reason (e.g. a source tarball
// with no .git directory).
function getBuildSha(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'unknown'
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __BUILD_SHA__: JSON.stringify(getBuildSha()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      // Registration happens via useRegisterSW() in UpdatePrompt.tsx so we
      // can show the "update available" prompt Claude.md calls for —
      // without this, the default auto-injected script would register the
      // service worker a second time.
      injectRegister: null,
      // Custom service worker (src/sw.ts) instead of the auto-generated
      // one — needed for the /offline-audio/<sourceFileId> Range-request
      // handler (see sw.ts), which generateSW mode has no way to express.
      // `filename` still resolves to dist/sw.js at scope '/', the same URL
      // an already-installed PWA already polls for, so this doesn't break
      // update discovery for existing installs.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        name: 'OzzBooks',
        short_name: 'OzzBooks',
        description: 'Audiobook + ebook player synced across your devices',
        start_url: '/',
        display: 'standalone',
        background_color: '#0f172a',
        theme_color: '#1e293b',
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      // injectManifest mode: sw.ts calls precacheAndRoute(self.__WB_MANIFEST)
      // itself, this just controls what goes into that manifest. The old
      // navigateFallbackDenylist (a generateSW-only option, protecting the
      // Google OAuth redirect to /api/sources/oauth/google/start from being
      // swallowed by the SPA fallback) is now hand-rolled as a
      // NavigationRoute denylist inside sw.ts instead.
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
    }),
  ],
})
