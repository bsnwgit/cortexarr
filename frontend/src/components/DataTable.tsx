import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { PageControls, PageSizeSelect } from './Pagination'

// Generic table used by ServiceDetail's tabs (queue/wanted/calendar/series/
// history) and meant to be reused as-is by future services' detail views —
// columns are the only thing that changes per view/service type. Filtering
// and pagination live here rather than per-tab so every view gets both for
// free, instead of each tab reimplementing its own.
export interface Column<T> {
  key: string
  label: string
  render?: (row: T) => ReactNode
  className?: string
  // Raw field to read for filtering, when it differs from `key` (a column
  // whose `render` combines two fields, e.g. "12 / 24", has nothing at
  // row[key] to search — point filterKey at the more useful of the two).
  filterKey?: string
  // false hides the column from the "filter on" picker entirely (still
  // contributes nothing to "All columns" either, since there's no matching
  // raw field) — for a column that's pure computed/derived display.
  filterable?: boolean
  // Raw field to read for sorting, when it differs from filterKey/key (same
  // reasoning as filterKey — a computed column needs a real field to sort by).
  sortKey?: string
  // false hides the column's header sort control — for a column with
  // nothing sortable behind it (e.g. an actions column).
  sortable?: boolean
}

function sortRawValue<T>(row: T, col: Column<T>): unknown {
  return (row as Record<string, unknown>)[col.sortKey ?? col.filterKey ?? col.key]
}

function compareValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

// Substring match against a chosen subset of a row's columns (or all of
// them) — no other per-column configuration needed, so a new view/column
// is searchable by default the moment it's added.
function rowMatches<T>(row: T, query: string, columns: Column<T>[], scope: Set<string>): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  if (!row || typeof row !== 'object') return false
  const active = scope.size === 0 ? columns : columns.filter((c) => scope.has(c.key))
  for (const c of active) {
    const value = (row as Record<string, unknown>)[c.filterKey ?? c.key]
    if (value == null) continue
    if (Array.isArray(value)) {
      if (value.some((v) => String(v).toLowerCase().includes(q))) return true
      continue
    }
    if (String(value).toLowerCase().includes(q)) return true
  }
  return false
}

function ColumnFilterPicker<T>({
  columns, scope, onChange,
}: { columns: Column<T>[]; scope: Set<string>; onChange: (next: Set<string>) => void }) {
  const filterable = columns.filter((c) => c.filterable !== false)
  const label = scope.size === 0
    ? 'All columns'
    : scope.size === 1
      ? filterable.find((c) => scope.has(c.key))?.label ?? '1 column'
      : `${scope.size} columns`

  function toggle(key: string) {
    const next = new Set(scope)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange(next)
  }

  const detailsRef = useRef<HTMLDetailsElement>(null)

  // Native <details> only closes on its own summary click — close it on any
  // click outside the whole element too, the way a dropdown is expected to behave.
  useEffect(() => {
    function onDocumentClick(e: MouseEvent) {
      if (detailsRef.current?.open && !detailsRef.current.contains(e.target as Node)) {
        detailsRef.current.open = false
      }
    }
    document.addEventListener('mousedown', onDocumentClick)
    return () => document.removeEventListener('mousedown', onDocumentClick)
  }, [])

  return (
    <details ref={detailsRef} className="relative shrink-0">
      <summary className="cursor-pointer list-none rounded-lg bg-slate-950 border border-slate-800 px-3 py-1.5 text-sm text-slate-100 select-none whitespace-nowrap">
        Filter on: {label}
      </summary>
      <div className="absolute z-10 mt-1 right-0 sm:right-auto w-56 rounded-lg border border-slate-800 bg-slate-925 p-2 shadow-lg space-y-0.5 max-h-64 overflow-y-auto">
        <label className="flex items-center gap-2 text-sm text-slate-100 px-2 py-1.5 rounded-lg hover:bg-slate-900 cursor-pointer">
          <input type="checkbox" checked={scope.size === 0} onChange={() => onChange(new Set())} />
          All columns
        </label>
        <div className="h-px bg-slate-800 my-1" />
        {filterable.map((c) => (
          <label key={c.key} className="flex items-center gap-2 text-sm text-slate-100 px-2 py-1.5 rounded-lg hover:bg-slate-900 cursor-pointer">
            <input type="checkbox" checked={scope.has(c.key)} onChange={() => toggle(c.key)} />
            {c.label}
          </label>
        ))}
      </div>
    </details>
  )
}

export default function DataTable<T extends { id?: number | string }>({
  columns,
  rows,
  emptyMessage,
  rowKey,
  defaultPageSize = 25,
  initialQuery = '',
  initialFilterScope = [],
}: {
  columns: Column<T>[]
  rows: T[]
  emptyMessage: string
  rowKey: (row: T, index: number) => string | number
  defaultPageSize?: number
  // Seeds the filter box/scope on first render — e.g. arriving from the
  // dashboard already scoped to one series, rather than the user retyping it.
  initialQuery?: string
  initialFilterScope?: string[]
}) {
  const [query, setQuery] = useState(initialQuery)
  const [filterScope, setFilterScope] = useState<Set<string>>(new Set(initialFilterScope))
  const [pageSize, setPageSize] = useState(defaultPageSize)
  const [page, setPage] = useState(1)
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const filtered = useMemo(
    () => rows.filter((r) => rowMatches(r, query, columns, filterScope)),
    [rows, query, columns, filterScope],
  )
  const sorted = useMemo(() => {
    if (!sortKey) return filtered
    const col = columns.find((c) => c.key === sortKey)
    if (!col) return filtered
    const dir = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => compareValues(sortRawValue(a, col), sortRawValue(b, col)) * dir)
  }, [filtered, columns, sortKey, sortDir])
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const page_ = Math.min(page, totalPages)
  const pageRows = useMemo(
    () => sorted.slice((page_ - 1) * pageSize, page_ * pageSize),
    [sorted, page_, pageSize],
  )

  function toggleSort(col: Column<T>) {
    if (col.sortable === false) return
    if (sortKey === col.key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(col.key)
      setSortDir('asc')
    }
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <input
            placeholder="Filter…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(1)
            }}
            className="rounded-lg bg-slate-950 border border-slate-800 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500 w-full sm:w-56"
          />
          <ColumnFilterPicker
            columns={columns}
            scope={filterScope}
            onChange={(next) => {
              setFilterScope(next)
              setPage(1)
            }}
          />
        </div>
        <div className="flex items-center gap-3 flex-wrap sm:justify-end">
          <PageSizeSelect
            value={pageSize}
            onChange={(n) => {
              setPageSize(n)
              setPage(1)
            }}
          />
          {totalPages > 1 && <PageControls page={page_} totalPages={totalPages} onChange={setPage} />}
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="text-slate-500 text-sm py-6 text-center">
          {rows.length === 0 ? emptyMessage : 'No rows match your filter.'}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto -mx-4 sm:mx-0">
            <table className="w-full text-sm min-w-[640px] sm:min-w-0">
              <thead>
                <tr className="text-left text-slate-400 border-b border-slate-800">
                  {columns.map((c) => (
                    <th key={c.key} className="font-medium py-2 px-3 whitespace-nowrap">
                      {c.sortable === false ? (
                        c.label
                      ) : (
                        <button
                          onClick={() => toggleSort(c)}
                          className="flex items-center gap-1 hover:text-slate-200"
                        >
                          {c.label}
                          <span className="w-3 inline-block text-slate-500">
                            {sortKey === c.key ? (sortDir === 'asc' ? '▲' : '▼') : ''}
                          </span>
                        </button>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row, i) => (
                  <tr key={rowKey(row, i)} className="border-b border-slate-900 last:border-0 hover:bg-slate-900/40">
                    {columns.map((c) => (
                      <td key={c.key} className={`py-2 px-3 text-slate-100 ${c.className ?? ''}`}>
                        {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? '—')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between mt-1">
            <span className="text-xs text-slate-500">
              {filtered.length} row{filtered.length === 1 ? '' : 's'}
              {query && rows.length !== filtered.length ? ` (filtered from ${rows.length})` : ''}
            </span>
          </div>
        </>
      )}
    </div>
  )
}
