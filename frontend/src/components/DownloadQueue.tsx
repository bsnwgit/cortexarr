import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import DataTable, { type Column } from './DataTable'
import ConfirmDeleteModal from './ConfirmDeleteModal'
import { TrashIcon } from './icons/UiIcons'
import type { ServiceAccent } from '../utils/serviceAccent'
import { fmtBytes, fmtDuration, wrapName } from '../utils/downloadFormat'

// What deleting from the queue does, per client — worded for the confirm.
const DELETE_NOTE: Record<string, string> = {
  nzbget: "from NZBGet's queue (it moves to history)",
  sabnzbd: "from SABnzbd's queue (files already downloaded are kept)",
}

interface QueueItem {
  id: number | string
  name: string
  category: string
  state: string
  state_label: string
  post_info: string
  post_progress_pct: number
  size_bytes: number
  remaining_bytes: number
  progress_pct: number | null
  health_pct: number | null
  critical_health_pct: number | null
  eta_seconds: number | null
  paused: boolean
  active: boolean
  can_control: boolean
}

// A download client's queue (NZBGet or SABnzbd), in its own order.
// Download-stage items can be paused/resumed, moved to the top, or deleted
// (after a typed confirmation); post-processing items can't.
export default function DownloadQueue({
  serviceId, serviceType, accent,
}: { serviceId: string; serviceType: string; accent: ServiceAccent }) {
  const [rows, setRows] = useState<QueueItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<Set<number | string>>(new Set())
  const [actionError, setActionError] = useState('')
  const [deleting, setDeleting] = useState<QueueItem | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  async function load() {
    try {
      setRows(await api.get<QueueItem[]>(`/services/${serviceId}/detail/queue`))
      setError('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const interval = setInterval(load, 5000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId])

  async function act(item: QueueItem, action: 'pause' | 'resume' | 'top' | 'delete') {
    setBusy((b) => new Set(b).add(item.id))
    setActionError('')
    try {
      await api.post(`/services/${serviceId}/downloads/${item.id}/${action}`)
      await load()
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Action failed')
    } finally {
      setBusy((b) => {
        const n = new Set(b)
        n.delete(item.id)
        return n
      })
    }
  }

  async function confirmDelete() {
    if (!deleting) return
    setDeleteBusy(true)
    await act(deleting, 'delete')
    setDeleteBusy(false)
    setDeleting(null)
  }

  const btn = 'text-xs px-2 py-1 rounded-lg border border-slate-700 text-slate-300 hover:border-slate-600 hover:bg-slate-900 disabled:opacity-50 transition-colors'

  const columns: Column<QueueItem>[] = [
    { key: 'name', label: 'Name', render: (r) => wrapName(r.name) },
    { key: 'category', label: 'Category', render: (r) => r.category || '—' },
    {
      key: 'state_label',
      label: 'Status',
      render: (r) => (
        <span className="flex flex-col">
          <span className={clsx(r.paused ? 'text-amber-300' : r.active ? accent.text : 'text-slate-100')}>
            {r.state_label}
            {r.post_info && r.post_progress_pct ? ` ${r.post_progress_pct}%` : ''}
          </span>
          {r.post_info && <span className="text-xs text-slate-400">{wrapName(r.post_info)}</span>}
        </span>
      ),
    },
    {
      key: 'progress_pct',
      label: 'Progress',
      filterable: false,
      render: (r) => (
        <span className="flex items-center gap-2 min-w-[110px]">
          <span className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
            <span className={clsx('block h-full bg-current', accent.text)} style={{ width: `${r.progress_pct ?? 0}%` }} />
          </span>
          <span className="text-xs text-slate-300 w-10 text-right">{r.progress_pct ?? 0}%</span>
        </span>
      ),
    },
    { key: 'size_bytes', label: 'Size', filterable: false, render: (r) => fmtBytes(r.size_bytes) },
    { key: 'remaining_bytes', label: 'Left', filterable: false, render: (r) => fmtBytes(r.remaining_bytes) },
    { key: 'eta_seconds', label: 'ETA', filterable: false, render: (r) => fmtDuration(r.eta_seconds) },
    {
      key: 'health_pct',
      label: 'Health',
      filterable: false,
      render: (r) =>
        r.health_pct == null ? (
          '—'
        ) : (
          <span
            className={
              r.critical_health_pct != null && r.health_pct < r.critical_health_pct
                ? 'text-red-300'
                : r.health_pct < 100 ? 'text-amber-300' : 'text-slate-100'
            }
          >
            {r.health_pct}%
          </span>
        ),
    },
    {
      key: 'actions',
      label: '',
      filterable: false,
      sortable: false,
      render: (r) => !r.can_control ? null : (
        <span className="flex gap-1.5">
          <button onClick={() => act(r, r.paused ? 'resume' : 'pause')} disabled={busy.has(r.id)} className={btn}>
            {r.paused ? 'Resume' : 'Pause'}
          </button>
          <button onClick={() => act(r, 'top')} disabled={busy.has(r.id)} className={btn} title="Move to top of queue">
            Top
          </button>
          <button
            onClick={() => setDeleting(r)}
            disabled={busy.has(r.id)}
            title="Delete from queue"
            className="p-1.5 rounded-lg border border-slate-700 text-slate-400 hover:text-red-300 hover:border-red-900 hover:bg-red-950/30 disabled:opacity-50 transition-colors"
          >
            <TrashIcon className="w-3.5 h-3.5" />
          </button>
        </span>
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
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} emptyMessage="The queue is empty." />
      )}
      {deleting && (
        <ConfirmDeleteModal
          title="Delete download"
          warning={`This removes "${deleting.name}" ${DELETE_NOTE[serviceType] ?? 'from the queue'}.`}
          busy={deleteBusy}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  )
}
