/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
  readonly VITE_API_TOKEN?: string
  readonly VITE_CLOUD_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
