import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import DataTable, { type Column } from '../components/DataTable'
import type { ServiceAccent } from '../utils/serviceAccent'

interface QueueItem {
  id: number
  series: string
  episode: string
  quality: string
  status: string
  tracked_status: string | null
  tracked_state: string | null
  timeleft: string | null
  download_client: string | null
  messages: string[]
}

interface HistoryItem {
  id: number
  event_type: string
  series: string
  episode: string
  source_title: string | null
  quality: string
  date: string | null
}

// Missing and Calendar both moved up to their own top-level tabs — this
// panel no longer has copies of either.
const SUB_TABS = [
  { key: 'queue', label: 'Queue' },
  { key: 'history', label: 'History' },
] as const

type SubTabKey = (typeof SUB_TABS)[number]['key']

function fmtDate(v: string | null) {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  return d.toLocaleString()
}

// "importPending" -> "Import pending" — trackedDownloadState is the pipeline
// stage (downloading/importPending/failed/...), which is what actually
// explains a queue item sitting at 100% progress with nothing happening —
// progress alone only reflects the download, not the import step after it.
function fmtState(s: string | null): string {
  if (!s) return ''
  const spaced = s.replace(/([A-Z])/g, ' $1').toLowerCase().trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

const QUEUE_COLUMNS: Column<QueueItem>[] = [
  { key: 'series', label: 'Series' },
  { key: 'episode', label: 'Episode' },
  { key: 'quality', label: 'Quality' },
  { key: 'timeleft', label: 'Time left', render: (r) => r.timeleft ?? '—' },
  {
    key: 'status',
    label: 'Status',
    render: (r) => {
      const label = fmtState(r.tracked_state) || r.status
      const stuck = r.tracked_status === 'warning' || r.tracked_status === 'error'
      return stuck ? <span className="text-amber-300">{label}</span> : label
    },
  },
  { key: 'download_client', label: 'Client', render: (r) => r.download_client ?? '—' },
  {
    key: 'messages',
    label: 'Messages',
    className: 'text-amber-300',
    render: (r) => (r.messages?.length ? r.messages.join('; ') : ''),
  },
]

const HISTORY_COLUMNS: Column<HistoryItem>[] = [
  { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) },
  { key: 'event_type', label: 'Event', className: 'capitalize' },
  { key: 'series', label: 'Series' },
  { key: 'episode', label: 'Episode' },
  { key: 'quality', label: 'Quality', render: (r) => r.quality || '—' },
]

// Queue/History — what's actively moving through the pipeline, as distinct
// from Series (the library), Missing, and Calendar (their own tabs now).
// Queue is always the sub-tab shown on first arriving here.
export default function DownloadingPanel({ serviceId, accent }: { serviceId: string; accent: ServiceAccent }) {
  const [searchParams] = useSearchParams()
  // Arriving from the dashboard's per-series "in queue" pill scopes the
  // filter to that series instead of showing everything for the service.
  const seriesFilter = searchParams.get('series') ?? ''
  const [subTab, setSubTab] = useState<SubTabKey>('queue')
  const [rows, setRows] = useState<unknown[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError('')
      try {
        const data = await api.get<unknown[]>(`/services/${serviceId}/detail/${subTab}`)
        if (!cancelled) setRows(data)
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const interval = setInterval(load, 20000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [serviceId, subTab])

  return (
    <div>
      <div className="flex gap-1 mb-4 overflow-x-auto">
        {SUB_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              // Same reasoning as the outer tab switch: clear rows in the
              // same update so a render never applies one sub-tab's columns
              // to another's row shape before the fetch resolves.
              setRows([])
              setSubTab(t.key)
            }}
            className={clsx(
              'px-3 py-1.5 rounded-lg text-sm whitespace-nowrap border',
              subTab === t.key
                ? clsx(accent.bg, accent.text, accent.border)
                : 'text-slate-400 hover:text-slate-200 border-transparent hover:bg-slate-900',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="bg-slate-925 border border-slate-800 rounded-xl p-2 sm:p-4">
        {error ? (
          <p className="text-red-300 text-sm py-6 text-center">{error}</p>
        ) : loading && rows.length === 0 ? (
          <p className="text-slate-500 text-sm py-6 text-center">Loading…</p>
        ) : subTab === 'queue' ? (
          <DataTable
            key={subTab}
            columns={QUEUE_COLUMNS}
            rows={rows as QueueItem[]}
            rowKey={(r) => r.id}
            emptyMessage="Nothing in the queue."
            initialQuery={seriesFilter}
            initialFilterScope={seriesFilter ? ['series'] : []}
          />
        ) : (
          <DataTable
            key={subTab}
            columns={HISTORY_COLUMNS}
            rows={rows as HistoryItem[]}
            rowKey={(r) => r.id}
            emptyMessage="No history yet."
            initialQuery={seriesFilter}
            initialFilterScope={seriesFilter ? ['series'] : []}
          />
        )}
      </div>
    </div>
  )
}
