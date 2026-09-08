/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
  readonly VITE_API_TOKEN?: string
  readonly VITE_CLOUD_API_BASE_URL?: string
  readonly VITE_GOOGLE_PICKER_API_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// Injected by vite.config.ts's `define` at build time — see Settings.tsx's
// footer, the one place a running instance's actual build is identifiable.
declare const __BUILD_SHA__: string
declare const __BUILD_TIME__: string
