import { useRegisterSW } from 'virtual:pwa-register/react'

// Per Claude.md's PWA platform concerns: updates must never land silently —
// a deploy otherwise just sits in the service worker's "waiting" state
// forever while the old cached bundle keeps being served, since
// registerType: 'prompt' deliberately doesn't auto-activate new versions.
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW()

  if (!needRefresh) return null

  return (
    <div className="fixed inset-x-0 top-0 z-50 flex items-center justify-between gap-3 bg-amber-400 px-4 py-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] text-sm font-medium text-slate-950">
      <span>A new version of OzzBooks is available.</span>
      <button
        onClick={() => updateServiceWorker(true)}
        className="shrink-0 rounded bg-slate-950 px-3 py-1 text-xs font-semibold text-amber-300"
      >
        Update
      </button>
    </div>
  )
}
