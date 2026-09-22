import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import DataTable, { type Column } from '../components/DataTable'
import ServiceIcon from '../components/ServiceIcon'

interface Service {
  id: number
  name: string
  type: string
  base_url: string
}

interface QueueItem {
  id: number
  series: string
  episode: string
  quality: string
  status: string
  tracked_status: string | null
  tracked_state: string | null
  progress_pct: number | null
  timeleft: string | null
  download_client: string | null
  messages: string[]
}

interface WantedItem {
  id: number
  series: string
  episode: string
  air_date: string | null
  monitored: boolean
}

interface CalendarItem {
  id: number
  series: string
  episode: string
  air_date: string | null
  has_file: boolean
  monitored: boolean
}

interface SeriesItem {
  id: number
  title: string
  status: string
  monitored: boolean
  episode_file_count: number
  episode_count: number
  size_on_disk: number
  network: string
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

const TABS = [
  { key: 'queue', label: 'Queue' },
  { key: 'wanted', label: 'Missing' },
  { key: 'calendar', label: 'Calendar' },
  { key: 'series', label: 'Series' },
  { key: 'history', label: 'History' },
] as const

type TabKey = (typeof TABS)[number]['key']

function fmtDate(v: string | null) {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  return d.toLocaleString()
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
  {
    key: 'progress_pct',
    label: 'Progress',
    render: (r) => (r.progress_pct == null ? '—' : `${r.progress_pct}%`),
  },
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

const WANTED_COLUMNS: Column<WantedItem>[] = [
  { key: 'series', label: 'Series' },
  { key: 'episode', label: 'Episode' },
  { key: 'air_date', label: 'Air date', render: (r) => fmtDate(r.air_date) },
  {
    key: 'monitored',
    label: 'Monitored',
    render: (r) => (r.monitored ? 'Yes' : <span className="text-slate-500">No</span>),
  },
]

const CALENDAR_COLUMNS: Column<CalendarItem>[] = [
  { key: 'air_date', label: 'Air date', render: (r) => fmtDate(r.air_date) },
  { key: 'series', label: 'Series' },
  { key: 'episode', label: 'Episode' },
  {
    key: 'has_file',
    label: 'Have file',
    render: (r) =>
      r.has_file ? (
        <span className="text-teal-300">Yes</span>
      ) : (
        <span className="text-slate-500">No</span>
      ),
  },
]

const SERIES_COLUMNS: Column<SeriesItem>[] = [
  { key: 'title', label: 'Title' },
  { key: 'status', label: 'Status', className: 'capitalize' },
  {
    key: 'monitored',
    label: 'Monitored',
    render: (r) => (r.monitored ? 'Yes' : <span className="text-slate-500">No</span>),
  },
  {
    key: 'episodes',
    label: 'Episodes',
    render: (r) => `${r.episode_file_count} / ${r.episode_count}`,
    filterable: false, // combines two fields — filterKey can only point at one, so leave it out of the picker
  },
  { key: 'size_on_disk', label: 'Size', render: (r) => fmtBytes(r.size_on_disk) },
  { key: 'network', label: 'Network', render: (r) => r.network || '—' },
]

const HISTORY_COLUMNS: Column<HistoryItem>[] = [
  { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) },
  { key: 'event_type', label: 'Event', className: 'capitalize' },
  { key: 'series', label: 'Series' },
  { key: 'episode', label: 'Episode' },
  { key: 'quality', label: 'Quality', render: (r) => r.quality || '—' },
]

export default function ServiceDetail() {
  const { id } = useParams<{ id: string }>()
  const [service, setService] = useState<Service | null>(null)
  const [tab, setTab] = useState<TabKey>('queue')
  const [rows, setRows] = useState<unknown[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!id) return
    api.get<Service>(`/services/${id}`).then(setService).catch(() => setService(null))
  }, [id])

  useEffect(() => {
    if (!id) return
    let cancelled = false
    async function load() {
      setLoading(true)
      setError('')
      try {
        const data = await api.get<unknown[]>(`/services/${id}/detail/${tab}`)
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
  }, [id, tab])

  return (
    <div>
      <div className="mb-4">
        <Link to="/" className="text-xs text-slate-400 hover:text-slate-200">
          ← Back to dashboard
        </Link>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-100 mt-1">
          {service && <ServiceIcon type={service.type} className="w-6 h-6 rounded-sm shrink-0" />}
          {service ? service.name : 'Service'}
        </h2>
        {service && <p className="text-xs text-slate-500">{service.type} · {service.base_url}</p>}
      </div>

      <div className="flex gap-1 mb-4 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              // Clear rows in the same update as the tab switch — otherwise
              // one render happens with the new tab's columns applied to the
              // previous tab's rows (different shape per view) before the
              // fetch below resolves, and a column that assumes a field the
              // old row type doesn't have throws and blanks the page.
              setRows([])
              setTab(t.key)
            }}
            className={clsx(
              'px-3 py-1.5 rounded-lg text-sm whitespace-nowrap border',
              tab === t.key
                ? 'bg-violet-600/20 text-violet-300 border-violet-600/40'
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
        ) : tab === 'queue' ? (
          <DataTable
            key={tab}
            columns={QUEUE_COLUMNS}
            rows={rows as QueueItem[]}
            rowKey={(r) => r.id}
            emptyMessage="Nothing in the queue."
          />
        ) : tab === 'wanted' ? (
          <DataTable
            key={tab}
            columns={WANTED_COLUMNS}
            rows={rows as WantedItem[]}
            rowKey={(r) => r.id}
            emptyMessage="No missing episodes."
          />
        ) : tab === 'calendar' ? (
          <DataTable
            key={tab}
            columns={CALENDAR_COLUMNS}
            rows={rows as CalendarItem[]}
            rowKey={(r) => r.id}
            emptyMessage="Nothing on the calendar."
          />
        ) : tab === 'series' ? (
          <DataTable
            key={tab}
            columns={SERIES_COLUMNS}
            rows={rows as SeriesItem[]}
            rowKey={(r) => r.id}
            emptyMessage="No series found."
          />
        ) : (
          <DataTable
            key={tab}
            columns={HISTORY_COLUMNS}
            rows={rows as HistoryItem[]}
            rowKey={(r) => r.id}
            emptyMessage="No history yet."
          />
        )}
      </div>
    </div>
  )
}
