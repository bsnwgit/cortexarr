import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import DataTable, { type Column } from './DataTable'
import type { ServiceAccent } from '../utils/serviceAccent'
import { fmtWhen, REQUEST_STATE_LABELS, requestStateClass, type RequestState } from '../utils/seerrFormat'
import PageSpinner from './PageSpinner'

interface SeerrRequest {
  id: number
  media_type: string
  title: string
  year: number | null
  poster_url: string
  seasons: number[]
  is_4k: boolean
  requested_by: string
  requested_at: string | null
  state: RequestState
}

const STATE_OPTIONS = Object.entries(REQUEST_STATE_LABELS) as [RequestState, string][]

// Seerr's Requests tab: every recent request with its status. A request
// still pending approval gets Approve/Decline — auto-approved requests
// never sit in that state, so they never show them — and a failed one
// gets Retry (re-sends it to Sonarr/Radarr).
export default function SeerrRequests({ serviceId, accent }: { serviceId: string; accent: ServiceAccent }) {
  const [searchParams] = useSearchParams()
  const [rows, setRows] = useState<SeerrRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [stateFilter, setStateFilter] = useState<string>(() => {
    const s = searchParams.get('status')
    return s && s in REQUEST_STATE_LABELS ? s : 'all'
  })
  const [busy, setBusy] = useState<Set<number>>(new Set())
  const [actionError, setActionError] = useState('')

  async function load() {
    try {
      setRows(await api.get<SeerrRequest[]>(`/services/${serviceId}/detail/requests`))
      setError('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const interval = setInterval(load, 30000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId])

  async function act(row: SeerrRequest, action: 'approve' | 'decline' | 'retry') {
    setBusy((b) => new Set(b).add(row.id))
    setActionError('')
    try {
      await api.post(`/services/${serviceId}/requests/${row.id}/${action}`)
      await load()
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : `Failed to ${action}`)
    } finally {
      setBusy((b) => {
        const n = new Set(b)
        n.delete(row.id)
        return n
      })
    }
  }

  const actionButton = 'text-xs px-2 py-1 rounded-lg border transition-colors disabled:opacity-50'

  const columns: Column<SeerrRequest>[] = [
    {
      key: 'title',
      label: 'Title',
      render: (r) => (
        <span className="flex items-center gap-2">
          {r.poster_url ? (
            <img src={r.poster_url} alt="" className="w-6 h-9 rounded object-cover shrink-0 border border-slate-800" />
          ) : (
            <span className="w-6 h-9 rounded bg-slate-900 shrink-0" />
          )}
          <span>
            {r.title}
            {r.year ? <span className="text-slate-400"> ({r.year})</span> : null}
          </span>
          {r.is_4k && <span className="text-[10px] px-1.5 py-0.5 rounded border border-slate-700 text-slate-300">4K</span>}
        </span>
      ),
    },
    {
      key: 'media_type',
      label: 'Type',
      render: (r) =>
        r.media_type === 'tv'
          ? `TV${r.seasons.length ? ` · S${r.seasons.join(', S')}` : ''}`
          : 'Movie',
    },
    { key: 'requested_by', label: 'Requested by' },
    { key: 'requested_at', label: 'Requested', render: (r) => fmtWhen(r.requested_at) },
    {
      key: 'state',
      label: 'Status',
      render: (r) => (
        <span className={clsx('text-xs px-2 py-0.5 rounded-lg border whitespace-nowrap', requestStateClass(r.state, accent))}>
          {REQUEST_STATE_LABELS[r.state] ?? r.state}
        </span>
      ),
    },
    {
      key: 'actions',
      label: '',
      filterable: false,
      sortable: false,
      render: (r) =>
        r.state === 'pending' ? (
          <span className="flex gap-1.5">
            <button
              onClick={() => act(r, 'approve')}
              disabled={busy.has(r.id)}
              className={clsx(actionButton, 'border-green-600/40 text-green-300 hover:bg-green-600/10')}
            >
              Approve
            </button>
            <button
              onClick={() => act(r, 'decline')}
              disabled={busy.has(r.id)}
              className={clsx(actionButton, 'border-red-600/40 text-red-300 hover:bg-red-600/10')}
            >
              Decline
            </button>
          </span>
        ) : r.state === 'failed' ? (
          <button
            onClick={() => act(r, 'retry')}
            disabled={busy.has(r.id)}
            className={clsx(actionButton, accent.border, accent.text, 'hover:bg-slate-900')}
          >
            Retry
          </button>
        ) : null,
    },
  ]

  const shown = stateFilter === 'all' ? rows : rows.filter((r) => r.state === stateFilter)

  return (
    <div className="bg-slate-925 border border-slate-800 rounded-xl p-2 sm:p-4">
      {actionError && <p className="text-red-300 text-xs mb-2">{actionError}</p>}
      {error ? (
        <p className="text-red-300 text-sm py-6 text-center">{error}</p>
      ) : loading ? (
        <PageSpinner className="py-6" />
      ) : (
        <DataTable
          columns={columns}
          rows={shown}
          rowKey={(r) => r.id}
          emptyMessage={stateFilter === 'all' ? 'No requests yet.' : `No ${REQUEST_STATE_LABELS[stateFilter as RequestState].toLowerCase()} requests.`}
          toolbar={
            <select
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value)}
              className="rounded-lg bg-slate-950 border border-slate-800 px-2 py-1.5 text-sm text-slate-100"
            >
              <option value="all">All requests</option>
              {STATE_OPTIONS.map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          }
        />
      )}
    </div>
  )
}
