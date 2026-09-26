import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
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
type StatusFilter = 'all' | 'monitored' | 'unmonitored' | 'ended' | 'continuing'

const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All series' },
  { value: 'monitored', label: 'Monitored' },
  { value: 'unmonitored', label: 'Unmonitored' },
  { value: 'continuing', label: 'Series Continuing' },
  { value: 'ended', label: 'Series Ended' },
]

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
            }}
            className="rounded-lg bg-slate-950 border border-slate-800 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500 w-full sm:w-64"
          />
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as StatusFilter)
              setPage(1)
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
