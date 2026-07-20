import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
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
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Without this, the service worker's default offline/SPA fallback
        // intercepts EVERY full-page navigation — including ones meant to
        // reach the server directly, like the Google Drive OAuth flow's
        // window.location.href to /api/sources/oauth/google/start — and
        // serves the cached index.html instead. React Router then boots up
        // at that URL, finds no matching route, and renders blank; the
        // request never reaches the server at all, so the OAuth redirect to
        // Google never happens. /api/* is never a client-side route, so it
        // should always hit the network.
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
})
