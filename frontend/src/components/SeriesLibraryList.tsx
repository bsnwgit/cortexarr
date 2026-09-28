import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import type { ServiceAccent } from '../utils/serviceAccent'
import { PageControls, PageSizeSelect } from './Pagination'

export interface SeriesLibraryItem {
  id: number
  title: string
  status: string
  monitored: boolean
  episode_file_count: number
  episode_count: number
  size_on_disk: number
  network: string
  poster_url: string
  year_range: string
  season_count: number
}

function fmtBytes(n: number) {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

// The series library — one horizontal row per series, poster thumbnail
// left, title and stats right, whole row clicking through to that series's
// full page (seasons, episodes, delete). Replaces the old plain data table
// for the Series tab per the library redesign.
type StatusFilter = 'all' | 'monitored' | 'unmonitored' | 'ended' | 'continuing' | 'missing'

const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All series' },
  { value: 'monitored', label: 'Monitored' },
  { value: 'unmonitored', label: 'Unmonitored' },
  { value: 'continuing', label: 'Series Continuing' },
  { value: 'ended', label: 'Series Ended' },
  { value: 'missing', label: 'Missing episodes' },
]

// Sonarr's own episodeCount is "monitored episodes that have aired (or
// have a file)" — so fewer files than that means an aired episode with
// nothing downloaded, the same definition the Missing tab uses.
function hasMissing(s: SeriesLibraryItem): boolean {
  return s.episode_file_count < s.episode_count
}

function matchesStatusFilter(s: SeriesLibraryItem, filter: StatusFilter): boolean {
  switch (filter) {
    case 'monitored':
      return s.monitored
    case 'unmonitored':
      return !s.monitored
    case 'ended':
      return s.status.toLowerCase() === 'ended'
    case 'continuing':
      return s.status.toLowerCase() === 'continuing'
    case 'missing':
      return hasMissing(s)
    default:
      return true
  }
}

export default function SeriesLibraryList({
  serviceId, accent, series,
}: { serviceId: string; accent: ServiceAccent; series: SeriesLibraryItem[] }) {
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [pageSize, setPageSize] = useState(25)
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [searching, setSearching] = useState(false)
  const [searchSummary, setSearchSummary] = useState<{ ok: boolean; text: string } | null>(null)

  const filtered = useMemo(
    () =>
      series
        .filter((s) => s.title.toLowerCase().includes(query.toLowerCase()))
        .filter((s) => matchesStatusFilter(s, statusFilter)),
    [series, query, statusFilter],
  )
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const page_ = Math.min(page, totalPages)
  const pageRows = useMemo(
    () => filtered.slice((page_ - 1) * pageSize, page_ * pageSize),
    [filtered, page_, pageSize],
  )

  function toggleSelected(id: number) {
    setSelected((sel) => {
      const next = new Set(sel)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setSearchSummary(null)
  }

  function toggleSelectAll() {
    setSearchSummary(null)
    setSelected((sel) => (sel.size === filtered.length ? new Set() : new Set(filtered.map((s) => s.id))))
  }

  async function searchSelected() {
    setSearching(true)
    setSearchSummary(null)
    try {
      const res = await api.post<{ results: { series_id: number; status: string }[]; ok: number }>(
        `/services/${serviceId}/series/search/bulk`,
        { series_ids: [...selected] },
      )
      const failed = res.results.length - res.ok
      setSearchSummary({
        ok: failed === 0,
        text: `Search started for ${res.ok} series${failed ? `, ${failed} failed` : ''}.`,
      })
      setSelected(new Set())
    } catch (err) {
      setSearchSummary({ ok: false, text: err instanceof ApiError ? err.message : 'Failed' })
    } finally {
      setSearching(false)
    }
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <input
            placeholder="Filter series…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(1)
              setSelected(new Set())
            }}
            className="rounded-lg bg-slate-950 border border-slate-800 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500 w-full sm:w-64"
          />
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as StatusFilter)
              setPage(1)
              setSelected(new Set())
            }}
            className="rounded-lg bg-slate-950 border border-slate-800 px-2 py-1.5 text-sm text-slate-100"
          >
            {STATUS_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
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

      {statusFilter === 'missing' && filtered.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              className="accent-violet-500"
              checked={selected.size > 0 && selected.size === filtered.length}
              onChange={toggleSelectAll}
            />
            Select all {filtered.length}
          </label>
          {selected.size > 0 && (
            <>
              <span className="text-sm text-slate-100 font-medium">{selected.size} selected</span>
              <button
                onClick={searchSelected}
                disabled={searching}
                className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-3 py-1.5"
              >
                {searching ? 'Searching…' : `Search all missing (${selected.size})`}
              </button>
              <button onClick={() => setSelected(new Set())} className="btn-secondary">
                Deselect
              </button>
            </>
          )}
          {searchSummary && (
            <span className={clsx('text-sm', searchSummary.ok ? 'text-teal-300' : 'text-red-300')}>
              {searchSummary.text}
            </span>
          )}
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="text-slate-500 text-sm py-6 text-center">
          {series.length === 0 ? 'No series found.' : 'No series match your filter.'}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {pageRows.map((s) => (
            <Link
              key={s.id}
              to={`/services/${serviceId}/series/${s.id}`}
              className="flex items-center gap-4 bg-slate-950 border border-slate-800 rounded-xl p-3 hover:border-violet-600/40 transition-colors"
            >
              {statusFilter === 'missing' && (
                <input
                  type="checkbox"
                  className="accent-violet-500 shrink-0"
                  checked={selected.has(s.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleSelected(s.id)}
                />
              )}
              <div className="w-12 h-[72px] shrink-0 bg-slate-900 rounded-md overflow-hidden flex items-center justify-center">
                {s.poster_url ? (
                  <img src={s.poster_url} alt="" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-slate-600 text-[10px] text-center px-1">No art</span>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-slate-100 truncate">{s.title}</span>
                  {s.year_range && <span className="text-xs text-slate-500">{s.year_range}</span>}
                  <span
                    className={clsx(
                      'text-xs px-2 py-0.5 rounded-lg border',
                      s.monitored ? clsx(accent.bg, accent.text, accent.border) : 'border-slate-700 text-slate-500',
                    )}
                  >
                    {s.monitored ? 'Monitored' : 'Unmonitored'}
                  </span>
                </div>
                <div className="text-xs text-slate-500 mt-1 flex gap-3 flex-wrap">
                  <span className="capitalize">{s.status}</span>
                  <span>{s.season_count} season{s.season_count === 1 ? '' : 's'}</span>
                  <span>{s.episode_file_count} / {s.episode_count} episodes</span>
                  <span>{fmtBytes(s.size_on_disk)}</span>
                  {s.network && <span>{s.network}</span>}
                </div>
              </div>
            </Link>
          ))}
          <span className="text-xs text-slate-500">
            {filtered.length} series{series.length !== filtered.length ? ` (filtered from ${series.length})` : ''}
          </span>
        </div>
      )}
    </div>
  )
}
