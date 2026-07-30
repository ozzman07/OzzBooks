// This generic message fires for ANY rejected fetch — a real network
// outage, or an unrelated JS exception thrown anywhere in the load path
// (e.g. a bug in a data-shaping helper). The optional detail line surfaces
// the actual error so that distinction doesn't have to be guessed at
// blind from outside the browser.
function describeError(error: unknown): string | null {
  if (error === undefined || error === null) return null
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  // Covers DOMException (e.g. IndexedDB failures) and anything else that
  // doesn't pass instanceof Error but still has useful name/message
  // fields, plus a last-resort fallback so *something* always shows
  // rather than silently telling describeError to give up.
  if (typeof error === 'object') {
    const name = 'name' in error ? String((error as { name?: unknown }).name) : 'Error'
    const message = 'message' in error ? String((error as { message?: unknown }).message) : null
    if (message) return `${name}: ${message}`
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

export function LibraryError({ onRetry, error }: { onRetry: () => void; error?: unknown }) {
  const detail = describeError(error)
  // Temporary bare-metal diagnostic — bypasses describeError entirely, so
  // even a bug in that function's own logic can't hide what's actually in
  // `error` (props.error is indistinguishable from "omitted" either way,
  // which is itself useful: it tells us this call site never got a real
  // error value to work with).
  const raw = `rawType=${typeof error} rawString=${String(error)}`
  return (
    <div className="flex flex-col items-center gap-3 px-6 pt-24 text-center text-muted">
      <p className="text-lg text-primary">Can't reach your library right now</p>
      <p className="text-sm">
        The Mac mini might be asleep or restarting. This usually resolves itself in a minute.
      </p>
      {detail && <p className="max-w-xs break-words text-xs text-subtle">{detail}</p>}
      <p className="max-w-xs break-words text-xs text-subtle">{raw}</p>
      <button
        onClick={onRetry}
        className="mt-2 rounded-lg bg-amber-400 px-4 py-2 text-sm font-medium text-slate-950"
      >
        Retry
      </button>
    </div>
  )
}
