import { useAppData } from '../data/AppDataContext'

// Same fixed-top-banner shape as UpdatePrompt.tsx, but warning-soft colors
// rather than amber so the two read as different severities if they're
// ever both showing at once. Purely informational — there's no action to
// take here beyond what the app already does on its own (retry on
// reconnect, see AppDataContext's `online` listener).
export function OfflineBanner() {
  const data = useAppData()

  if (!data.isOffline) return null

  return (
    <div className="fixed inset-x-0 top-0 z-40 bg-warning-soft px-4 py-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] text-center text-xs text-warning-soft-text">
      Can't reach the Mac mini — showing what was last loaded.
    </div>
  )
}
