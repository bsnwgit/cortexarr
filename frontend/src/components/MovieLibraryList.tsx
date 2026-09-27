import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import type { ServiceAccent } from '../utils/serviceAccent'
import { fmtBytes, fmtRuntime, movieAvailability, movieStatusLabel } from '../utils/movieFormat'
import { PageControls, PageSizeSelect } from './Pagination'

export interface MovieLibraryItem {
  id: number
  title: string
  year: number | null
  status: string | null
  monitored: boolean
  has_file: boolean
  is_available: boolean
  size_on_disk: number
  studio: string
  runtime: number
  certification: string
  quality: string
  poster_url: string
}

type MovieFilter = 'all' | 'monitored' | 'unmonitored' | 'downloaded' | 'missing' | 'released' | 'upcoming'

const FILTER_OPTIONS: { value: MovieFilter; label: string }[] = [
  { value: 'all', label: 'All movies' },
  { value: 'monitored', label: 'Monitored' },
  { value: 'unmonitored', label: 'Unmonitored' },
  { value: 'downloaded', label: 'Downloaded' },
  { value: 'missing', label: 'Missing' },
  { value: 'released', label: 'Released' },
  { value: 'upcoming', label: 'Not yet released' },
]

function matchesFilter(m: MovieLibraryItem, f: MovieFilter): boolean {
  switch (f) {
    case 'monitored':
      return m.monitored
    case 'unmonitored':
      return !m.monitored
    case 'downloaded':
      return m.has_file
    case 'missing':
      return !m.has_file && m.is_available
    case 'released':
      return m.is_available
    case 'upcoming':
      return !m.is_available
    default:
      return true
  }
}

// The Radarr Movies tab — the movie counterpart of SeriesLibraryList: one
// horizontal poster row per movie, clicking through to its own page.
// Self-fetching, since nothing else on the service page needs the library.
export default function MovieLibraryList({ serviceId, accent }: { serviceId: string; accent: ServiceAccent }) {
  const [movies, setMovies] = useState<MovieLibraryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<MovieFilter>('all')
  const [pageSize, setPageSize] = useState(25)
  const [page, setPage] = useState(1)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const data = await api.get<MovieLibraryItem[]>(`/services/${serviceId}/detail/movies`)
        if (!cancelled) {
          setMovies(data)
          setError('')
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const interval = setInterval(load, 60000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [serviceId])

  const filtered = useMemo(
    () =>
      movies
        .filter((m) => m.title.toLowerCase().includes(query.toLowerCase()))
        .filter((m) => matchesFilter(m, filter)),
    [movies, query, filter],
  )
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const page_ = Math.min(page, totalPages)
  const pageRows = useMemo(
    () => filtered.slice((page_ - 1) * pageSize, page_ * pageSize),
    [filtered, page_, pageSize],
  )

  if (error) return <p className="text-red-300 text-sm py-6 text-center">{error}</p>
  if (loading) return <p className="text-slate-500 text-sm py-6 text-center">Loading…</p>

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <input
            placeholder="Filter movies…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(1)
            }}
            className="rounded-lg bg-slate-950 border border-slate-800 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500 w-full sm:w-64"
          />
          <select
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value as MovieFilter)
              setPage(1)
            }}
            className="rounded-lg bg-slate-950 border border-slate-800 px-2 py-1.5 text-sm text-slate-100"
          >
            {FILTER_OPTIONS.map((opt) => (
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
          {movies.length === 0 ? 'No movies found.' : 'No movies match your filter.'}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {pageRows.map((m) => {
            const avail = movieAvailability(m, accent)
            return (
              <Link
                key={m.id}
                to={`/services/${serviceId}/movies/${m.id}`}
                className={clsx(
                  'flex items-center gap-4 bg-slate-950 border border-slate-800 rounded-xl p-3 transition-colors',
                  accent.hoverBorder,
                )}
              >
                <div className="w-12 h-[72px] shrink-0 bg-slate-900 rounded-md overflow-hidden flex items-center justify-center">
                  {m.poster_url ? (
                    <img src={m.poster_url} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-slate-500 text-[10px] text-center px-1">No art</span>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-slate-100 truncate">{m.title}</span>
                    {m.year && <span className="text-xs text-slate-400">{m.year}</span>}
                    <span className={clsx('text-xs px-2 py-0.5 rounded-lg border', avail.className)}>{avail.label}</span>
                    <span
                      className={clsx(
                        'text-xs px-2 py-0.5 rounded-lg border',
                        m.monitored ? clsx(accent.bg, accent.text, accent.border) : 'border-slate-700 text-slate-400',
                      )}
                    >
                      {m.monitored ? 'Monitored' : 'Unmonitored'}
                    </span>
                  </div>
                  <div className="text-xs text-slate-400 mt-1 flex gap-3 flex-wrap">
                    <span>{movieStatusLabel(m.status)}</span>
                    {m.runtime > 0 && <span>{fmtRuntime(m.runtime)}</span>}
                    {m.certification && <span>{m.certification}</span>}
                    {m.quality && <span>{m.quality}</span>}
                    {m.has_file && <span>{fmtBytes(m.size_on_disk)}</span>}
                    {m.studio && <span>{m.studio}</span>}
                  </div>
                </div>
              </Link>
            )
          })}
          <span className="text-xs text-slate-400">
            {filtered.length} movie{filtered.length === 1 ? '' : 's'}
            {movies.length !== filtered.length ? ` (filtered from ${movies.length})` : ''}
          </span>
        </div>
      )}
    </div>
  )
}
