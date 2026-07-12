export function Settings() {
  return (
    <div className="mx-auto max-w-md px-4 pb-24 pt-6">
      <h1 className="mb-4 text-2xl font-semibold text-slate-50">Settings</h1>

      <section className="mb-6 rounded-lg border border-slate-800 p-4">
        <h2 className="mb-1 text-sm font-medium text-slate-200">Storage</h2>
        <p className="text-sm text-slate-400">
          Download management and storage budget controls land once offline chapter caching is
          wired up.
        </p>
      </section>

      <section className="mb-6 rounded-lg border border-slate-800 p-4">
        <h2 className="mb-1 text-sm font-medium text-slate-200">Account</h2>
        <p className="text-sm text-slate-400">
          Login and multi-user support land alongside the cloud sync layer.
        </p>
      </section>

      <p className="text-center text-xs text-slate-600">OzzBooks — Phase 1</p>
    </div>
  )
}
