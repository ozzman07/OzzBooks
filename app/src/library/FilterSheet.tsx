import { useState } from 'react'
import type { StatusFilter, FormatFilter } from './LibraryViewContext'

export interface FacetOption {
  value: string
  label: string
  count: number
}

export interface SingleSelectFacet<T extends string> {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string; count?: number }[]
}

export interface MultiSelectFacet {
  selected: Set<string>
  onToggle: (value: string) => void
  options: FacetOption[]
  /** Shown once the option list exceeds this — a text box to narrow a long
   * facet (narrator) rather than scrolling through everything. Omitted for
   * short controlled lists (genre) where it'd just be visual clutter. */
  searchThreshold?: number
}

interface FilterSheetProps {
  open: boolean
  onClose: () => void
  status: SingleSelectFacet<StatusFilter>
  format: SingleSelectFacet<FormatFilter>
  source: MultiSelectFacet
  genre: MultiSelectFacet
  narrator: MultiSelectFacet
  onClearAll: () => void
  resultCount: number
}

function SingleSelectRow<T extends string>({ facet }: { facet: SingleSelectFacet<T> }) {
  return (
    <div className="flex flex-wrap gap-2">
      {facet.options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => facet.onChange(opt.value)}
          className={`rounded-full border px-3 py-1 text-xs ${
            facet.value === opt.value
              ? 'border-amber-400 bg-amber-400 text-slate-950'
              : 'border-border-strong bg-surface text-secondary'
          }`}
        >
          {opt.label}
          {opt.count !== undefined && <span className="ml-1 opacity-70">({opt.count})</span>}
        </button>
      ))}
    </div>
  )
}

function MultiSelectSection({ facet }: { facet: MultiSelectFacet }) {
  const [search, setSearch] = useState('')
  const needsSearch = facet.searchThreshold !== undefined && facet.options.length > facet.searchThreshold
  const visibleOptions = needsSearch
    ? facet.options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
    : facet.options

  return (
    <div>
      {needsSearch && (
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          className="mb-2 w-full rounded border border-border-strong bg-surface px-2 py-1 text-xs text-primary placeholder:text-subtle"
        />
      )}
      <div className={`flex flex-col gap-1 ${needsSearch ? 'max-h-48 overflow-y-auto' : ''}`}>
        {visibleOptions.length === 0 && <p className="text-xs text-subtle">No matches.</p>}
        {visibleOptions.map((opt) => (
          <label key={opt.value} className="flex items-center gap-2 rounded px-1 py-1 text-sm text-secondary">
            <input type="checkbox" checked={facet.selected.has(opt.value)} onChange={() => facet.onToggle(opt.value)} />
            <span className="flex-1">{opt.label}</span>
            <span className="text-xs text-subtle">{opt.count}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

/**
 * Ecommerce-style faceted filter panel — replaces the old fixed row of
 * Status/Format toggle buttons, which didn't scale once Genre (a ~17-value
 * controlled list), Narrator (open-ended, a real library can have 60+),
 * and Source (multi-user households connecting their own sources —
 * Jim's request, 2026-08-16) needed their own filters too. Bottom sheet
 * rather than a desktop sidebar since this app is mobile-first (bottom
 * nav). Every facet's counts reflect every *other* currently-active
 * filter but never its own selection — standard faceted-search behavior,
 * so unchecked options still show what you'd get by adding them instead
 * of freezing at whatever the count was before you opened the sheet.
 */
export function FilterSheet({ open, onClose, status, format, source, genre, narrator, onClearAll, resultCount }: FilterSheetProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/60" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col rounded-t-2xl bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border-strong px-4 py-3">
          <h2 className="text-sm font-semibold text-primary">Filters</h2>
          <button onClick={onClearAll} className="text-xs text-amber-400 underline">
            Clear all
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
          <section>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Status</h3>
            <SingleSelectRow facet={status} />
          </section>
          <section>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Format</h3>
            <SingleSelectRow facet={format} />
          </section>
          <section>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Source</h3>
            <MultiSelectSection facet={source} />
          </section>
          <section>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Genre</h3>
            <MultiSelectSection facet={genre} />
          </section>
          <section>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Narrator</h3>
            <MultiSelectSection facet={narrator} />
          </section>
        </div>

        <div className="border-t border-border-strong px-4 py-3">
          <button onClick={onClose} className="w-full rounded-lg bg-amber-400 px-4 py-2 text-sm font-medium text-slate-950">
            Show {resultCount} book{resultCount === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  )
}
