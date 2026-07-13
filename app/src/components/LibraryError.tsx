export function LibraryError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 pt-24 text-center text-slate-400">
      <p className="text-lg text-slate-200">Can't reach your library right now</p>
      <p className="text-sm">
        The Mac mini might be asleep or restarting. This usually resolves itself in a minute.
      </p>
      <button
        onClick={onRetry}
        className="mt-2 rounded-lg bg-amber-400 px-4 py-2 text-sm font-medium text-slate-950"
      >
        Retry
      </button>
    </div>
  )
}
