import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import DataTable, { type Column } from './DataTable'
import type { ServiceAccent } from '../utils/serviceAccent'
import { fmtWhen } from '../utils/seerrFormat'
import PageSpinner from './PageSpinner'

interface SeerrIssue {
  id: string
  source: 'failed_request' | 'reported'
  request_id: number | null
  issue_type: string
  media_type: string
  title: string
  year: number | null
  poster_url: string
  season: number | null
  episode: number | null
  seasons: number[]
  reported_by: string
  created_at: string | null
  message: string
  reason_found: boolean
  sent_to: string | null
}

const pad = (n: number) => String(n).padStart(2, '0')

function where(r: SeerrIssue): string {
  if (r.season != null && r.episode != null) return `S${pad(r.season)}E${pad(r.episode)}`
  if (r.season != null) return `Season ${r.season}`
  if (r.seasons.length) return `S${r.seasons.join(', S')}`
  return r.media_type === 'tv' ? 'Whole series' : '—'
}

// Seerr's Issues tab: everything wrong on the request side — requests that
// failed to reach Sonarr/Radarr (with the reason from Seerr's log, and
// Retry), and problems users reported against a title.
export default function SeerrIssues({ serviceId, accent }: { serviceId: string; accent: ServiceAccent }) {
  const [rows, setRows] = useState<SeerrIssue[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [actionError, setActionError] = useState('')

  async function load() {
    try {
      setRows(await api.get<SeerrIssue[]>(`/services/${serviceId}/detail/issues`))
      setError('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const interval = setInterval(load, 60000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId])

  async function retry(r: SeerrIssue) {
    if (r.request_id == null) return
    setBusy((b) => new Set(b).add(r.id))
    setActionError('')
    try {
      await api.post(`/services/${serviceId}/requests/${r.request_id}/retry`)
      await load()
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to retry')
    } finally {
      setBusy((b) => {
        const n = new Set(b)
        n.delete(r.id)
        return n
      })
    }
  }

  const columns: Column<SeerrIssue>[] = [
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
        </span>
      ),
    },
    {
      key: 'issue_type',
      label: 'Issue',
      render: (r) => (
        <span
          className={clsx(
            'text-xs px-2 py-0.5 rounded-lg border whitespace-nowrap',
            r.source === 'failed_request'
              ? 'text-red-300 border-red-600/40 bg-red-600/10'
              : 'text-amber-300 border-amber-600/40 bg-amber-600/10',
          )}
        >
          {r.issue_type}
        </span>
      ),
    },
    { key: 'where', label: 'Where', filterable: false, sortable: false, render: where },
    {
      key: 'message',
      label: 'Details',
      render: (r) =>
        r.source === 'failed_request' ? (
          r.reason_found ? (
            <span>
              <span className="text-slate-400">{r.sent_to}: </span>
              {r.message}
            </span>
          ) : (
            <span className="text-slate-400 italic">{r.message}</span>
          )
        ) : (
          r.message || '—'
        ),
    },
    { key: 'reported_by', label: 'By' },
    { key: 'created_at', label: 'When', render: (r) => fmtWhen(r.created_at) },
    {
      key: 'actions',
      label: '',
      filterable: false,
      sortable: false,
      render: (r) =>
        r.source === 'failed_request' ? (
          <button
            onClick={() => retry(r)}
            disabled={busy.has(r.id)}
            className={clsx(
              'text-xs px-2 py-1 rounded-lg border transition-colors disabled:opacity-50 hover:bg-slate-900',
              accent.border,
              accent.text,
            )}
          >
            Retry
          </button>
        ) : null,
    },
  ]

  return (
    <div className="bg-slate-925 border border-slate-800 rounded-xl p-2 sm:p-4">
      {actionError && <p className="text-red-300 text-xs mb-2">{actionError}</p>}
      {error ? (
        <p className="text-red-300 text-sm py-6 text-center">{error}</p>
      ) : loading ? (
        <PageSpinner className="py-6" />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} emptyMessage="No failed requests or open issues." />
      )}
    </div>
  )
}
