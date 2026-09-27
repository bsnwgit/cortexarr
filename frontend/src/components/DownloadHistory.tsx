import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import DataTable, { type Column } from './DataTable'
import type { ServiceAccent } from '../utils/serviceAccent'
import { fmtBytes, fmtWhen, OUTCOME_LABELS, outcomeClass, wrapName } from '../utils/downloadFormat'
import PageSpinner from './PageSpinner'

interface HistoryItem {
  id: number | string
  name: string
  category: string
  outcome: string
  status: string
  detail: string
  size_bytes: number
  date: string | null
  reason: string
}

// A download client's history (NZBGet or SABnzbd), newest first. Failed and warning items show why — the
// errors from that download's own log — and failed ones can be retried
// (sent back to the queue to download again).
export default function DownloadHistory({ serviceId, accent }: { serviceId: string; accent: ServiceAccent }) {
  const [rows, setRows] = useState<HistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [outcome, setOutcome] = useState('all')
  const [busy, setBusy] = useState<Set<number | string>>(new Set())
  const [retried, setRetried] = useState<Set<number | string>>(new Set())
  const [actionError, setActionError] = useState('')
  const accentClasses = `${accent.text} ${accent.border} ${accent.bg}`

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const data = await api.get<HistoryItem[]>(`/services/${serviceId}/detail/history`)
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

  async function retry(item: HistoryItem) {
    setBusy((b) => new Set(b).add(item.id))
    setActionError('')
    try {
      await api.post(`/services/${serviceId}/downloads/${item.id}/retry`)
      setRetried((r) => new Set(r).add(item.id))
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to retry')
    } finally {
      setBusy((b) => {
        const n = new Set(b)
        n.delete(item.id)
        return n
      })
    }
  }

  const columns: Column<HistoryItem>[] = [
    { key: 'name', label: 'Name', render: (r) => wrapName(r.name) },
    { key: 'category', label: 'Category', render: (r) => r.category || '—' },
    {
      key: 'outcome',
      label: 'Result',
      render: (r) => (
        <span className={clsx('text-xs px-2 py-0.5 rounded-lg border whitespace-nowrap', outcomeClass(r.outcome, accentClasses))}>
          {OUTCOME_LABELS[r.outcome] ?? r.status}
        </span>
      ),
    },
    {
      key: 'reason',
      label: 'Details',
      render: (r) =>
        r.reason ? (
          <span>
            {r.detail && <span className="text-slate-400">{r.detail}: </span>}
            {r.reason}
          </span>
        ) : (
          r.detail || '—'
        ),
    },
    { key: 'size_bytes', label: 'Size', filterable: false, render: (r) => fmtBytes(r.size_bytes) },
    { key: 'date', label: 'When', render: (r) => fmtWhen(r.date) },
    {
      key: 'actions',
      label: '',
      filterable: false,
      sortable: false,
      render: (r) =>
        r.outcome !== 'failure' ? null : retried.has(r.id) ? (
          <span className={clsx('text-xs', accent.text)}>Re-queued</span>
        ) : (
          <button
            onClick={() => retry(r)}
            disabled={busy.has(r.id)}
            className={clsx('text-xs px-2 py-1 rounded-lg border transition-colors disabled:opacity-50 hover:bg-slate-900', accent.border, accent.text)}
          >
            Retry
          </button>
        ),
    },
  ]

  const shown = outcome === 'all' ? rows : rows.filter((r) => r.outcome === outcome)

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
          emptyMessage={outcome === 'all' ? 'No history yet.' : 'Nothing with that result.'}
          toolbar={
            <select
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              className="rounded-lg bg-slate-950 border border-slate-800 px-2 py-1.5 text-sm text-slate-100"
            >
              <option value="all">All results</option>
              {Object.entries(OUTCOME_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          }
        />
      )}
    </div>
  )
}
