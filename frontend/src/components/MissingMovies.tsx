import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError } from '../api/client'
import DataTable, { type Column } from './DataTable'
import MonitoredToggle from './MonitoredToggle'
import { SearchIcon } from './icons/UiIcons'
import type { ServiceAccent } from '../utils/serviceAccent'
import { fmtDay, movieStatusLabel } from '../utils/movieFormat'

interface MissingMovie {
  id: number
  movie_id: number
  title: string
  year: number | null
  status: string | null
  release_date: string | null
  monitored: boolean
  poster_url: string
}

// Radarr's Missing tab — monitored movies that are out but have no file.
// A flat table rather than Sonarr's grouped-by-series view: each movie is
// already its own "group". Every row links to its movie page and can be
// searched for or unmonitored in place.
export default function MissingMovies({ serviceId, accent }: { serviceId: string; accent: ServiceAccent }) {
  const [rows, setRows] = useState<MissingMovie[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<Set<number>>(new Set())
  const [searched, setSearched] = useState<Set<number>>(new Set())
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const data = await api.get<MissingMovie[]>(`/services/${serviceId}/detail/wanted`)
        if (!cancelled) {
          setRows(data)
          setError('')
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const interval = setInterval(load, 30000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [serviceId])

  function setRowBusy(id: number, on: boolean) {
    setBusy((b) => {
      const n = new Set(b)
      if (on) n.add(id)
      else n.delete(id)
      return n
    })
  }

  async function toggleMonitored(row: MissingMovie) {
    setRowBusy(row.id, true)
    setActionError('')
    const next = !row.monitored
    try {
      await api.patch(`/services/${serviceId}/movies/${row.movie_id}/monitored`, { monitored: next })
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, monitored: next } : r)))
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to update')
    } finally {
      setRowBusy(row.id, false)
    }
  }

  async function search(row: MissingMovie) {
    setRowBusy(row.id, true)
    setActionError('')
    try {
      await api.post(`/services/${serviceId}/movies/${row.movie_id}/search`)
      setSearched((s) => new Set(s).add(row.id))
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to trigger search')
    } finally {
      setRowBusy(row.id, false)
    }
  }

  const columns: Column<MissingMovie>[] = [
    {
      key: 'title',
      label: 'Movie',
      render: (r) => (
        <Link to={`/services/${serviceId}/movies/${r.movie_id}`} className="flex items-center gap-2 hover:underline">
          {r.poster_url ? (
            <img src={r.poster_url} alt="" className="w-6 h-9 rounded object-cover shrink-0 border border-slate-800" />
          ) : (
            <span className="w-6 h-9 rounded bg-slate-900 shrink-0" />
          )}
          {r.title}
        </Link>
      ),
    },
    { key: 'year', label: 'Year', render: (r) => r.year ?? '—' },
    { key: 'release_date', label: 'Released', render: (r) => fmtDay(r.release_date) },
    { key: 'status', label: 'Status', render: (r) => movieStatusLabel(r.status) },
    {
      key: 'monitored',
      label: 'Monitored',
      filterable: false,
      render: (r) => (
        <MonitoredToggle monitored={r.monitored} busy={busy.has(r.id)} accent={accent} onClick={() => toggleMonitored(r)} />
      ),
    },
    {
      key: 'actions',
      label: '',
      filterable: false,
      sortable: false,
      render: (r) =>
        searched.has(r.id) ? (
          <span className={`text-xs ${accent.text}`}>Search sent</span>
        ) : (
          <button
            onClick={() => search(r)}
            disabled={busy.has(r.id)}
            title="Search for this movie"
            className={`p-1.5 rounded-lg border border-slate-700 hover:border-slate-600 disabled:opacity-50 transition-colors ${accent.text}`}
          >
            <SearchIcon className="w-3.5 h-3.5" />
          </button>
        ),
    },
  ]

  return (
    <div className="bg-slate-925 border border-slate-800 rounded-xl p-2 sm:p-4">
      {actionError && <p className="text-red-300 text-xs mb-2">{actionError}</p>}
      {error ? (
        <p className="text-red-300 text-sm py-6 text-center">{error}</p>
      ) : loading ? (
        <p className="text-slate-500 text-sm py-6 text-center">Loading…</p>
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} emptyMessage="No missing movies." />
      )}
    </div>
  )
}
