import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import DataTable, { type Column } from '../components/DataTable'
import type { ServiceAccent } from '../utils/serviceAccent'
import { fmtDateTime } from '../utils/time'
import PageSpinner from './PageSpinner'

// The fields shared by Sonarr's and Radarr's queue rows — everything but
// the title, which is series/episode for one and movie/year for the other.
interface QueueRow {
  id: number
  quality: string
  status: string
  tracked_status: string | null
  tracked_state: string | null
  timeleft: string | null
  download_client: string | null
  messages: string[]
}

interface QueueItem extends QueueRow {
  series: string
  episode: string
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
  return fmtDateTime(d)
}

// "importPending" -> "Import pending" — trackedDownloadState is the pipeline
// stage (downloading/importPending/failed/...), which is what actually
// explains a queue item sitting at 100% progress with nothing happening —
// progress alone only reflects the download, not the import step after it.
export function fmtState(s: string | null): string {
  if (!s) return ''
  const spaced = s.replace(/([A-Z])/g, ' $1').toLowerCase().trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

// One busy/result pair per queue item id, shared across whichever action
// (import/remove/redownload) is running or just finished on that row.
export type QueueActionState = Record<number, { busy: string | null; result: { ok: boolean; text: string } | null }>

function actionsColumn<T extends QueueRow>(onAction: (r: T, action: string) => void, state: QueueActionState): Column<T> {
  return {
    key: 'actions',
    label: 'Actions',
    sortable: false,
    filterable: false,
    render: (r) => {
      const s = state[r.id]
      return (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => onAction(r, 'import')}
            disabled={!!s?.busy}
            className="rounded-md bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-medium px-2 py-1"
          >
            {s?.busy === 'import' ? 'Importing…' : 'Import'}
          </button>
          <button
            onClick={() => onAction(r, 'redownload')}
            disabled={!!s?.busy}
            className="rounded-md bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-100 text-xs font-medium px-2 py-1"
          >
            {s?.busy === 'redownload' ? 'Working…' : 'Remove & search'}
          </button>
          <button
            onClick={() => onAction(r, 'remove')}
            disabled={!!s?.busy}
            className="rounded-md bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-100 text-xs font-medium px-2 py-1"
          >
            {s?.busy === 'remove' ? 'Removing…' : 'Remove'}
          </button>
          {s?.result && (
            <span className={clsx('text-xs', s.result.ok ? 'text-teal-300' : 'text-red-300')}>{s.result.text}</span>
          )}
        </div>
      )
    },
  }
}

// Shared by both Sonarr and Radarr queue tables — everything after the
// series/movie title column, which is the one part that differs per type.
function sharedQueueColumns<T extends QueueRow>(): Column<T>[] {
  return [
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
}

function queueColumns(onAction: (r: QueueItem, action: string) => void, state: QueueActionState): Column<QueueItem>[] {
  return [{ key: 'series', label: 'Series' }, { key: 'episode', label: 'Episode' }, ...sharedQueueColumns<QueueItem>(), actionsColumn(onAction, state)]
}

const HISTORY_COLUMNS: Column<HistoryItem>[] = [
  { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) },
  { key: 'event_type', label: 'Event', className: 'capitalize' },
  { key: 'series', label: 'Series' },
  { key: 'episode', label: 'Episode' },
  { key: 'quality', label: 'Quality', render: (r) => r.quality || '—' },
]

interface RadarrQueueItem extends Omit<QueueItem, 'series' | 'episode'> {
  movie: string
  year: number | null
}

interface RadarrHistoryItem extends Omit<HistoryItem, 'series' | 'episode'> {
  movie: string
  year: number | null
}

const movieTitle = (r: { movie: string; year: number | null }) => (r.year ? `${r.movie} (${r.year})` : r.movie)

function radarrQueueColumns(onAction: (r: RadarrQueueItem, action: string) => void, state: QueueActionState): Column<RadarrQueueItem>[] {
  return [
    { key: 'movie', label: 'Movie', render: movieTitle },
    ...sharedQueueColumns<RadarrQueueItem>(),
    actionsColumn(onAction, state),
  ]
}

const RADARR_HISTORY_COLUMNS: Column<RadarrHistoryItem>[] = [
  { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) },
  { key: 'event_type', label: 'Event', render: (r) => fmtState(r.event_type) },
  { key: 'movie', label: 'Movie', render: movieTitle },
  { key: 'quality', label: 'Quality', render: (r) => r.quality || '—' },
  { key: 'source_title', label: 'Release', render: (r) => r.source_title || '—' },
]

type Row = { id: number }
const cols = <T,>(c: Column<T>[]) => c as unknown as Column<Row>[]

// Per service type: its history columns and which URL param the dashboard
// card uses to pre-scope the filter (and to which column). Queue columns
// are built per-render instead, since they close over the action handler.
const PANEL_CONFIG: Record<string, { history: Column<Row>[]; filterParam: string }> = {
  sonarr: { history: cols(HISTORY_COLUMNS), filterParam: 'series' },
  radarr: { history: cols(RADARR_HISTORY_COLUMNS), filterParam: 'movie' },
}

// Queue/History — what's actively moving through the pipeline, as distinct
// from the library, Missing, and Calendar (their own tabs). Queue is always
// the sub-tab shown on first arriving here.
export default function DownloadingPanel({
  serviceId, serviceType, accent,
}: { serviceId: string; serviceType: string; accent: ServiceAccent }) {
  const [searchParams] = useSearchParams()
  const config = PANEL_CONFIG[serviceType] ?? PANEL_CONFIG.sonarr
  // Arriving from a dashboard card's per-item pill scopes the filter to
  // that series/movie instead of showing everything for the service.
  const itemFilter = searchParams.get(config.filterParam) ?? ''
  const [subTab, setSubTab] = useState<SubTabKey>('queue')
  const [rows, setRows] = useState<unknown[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionState, setActionState] = useState<QueueActionState>({})

  async function runQueueAction(r: { id: number }, action: string) {
    setActionState((s) => ({ ...s, [r.id]: { busy: action, result: null } }))
    try {
      const res = await api.post<{ files?: number }>(`/services/${serviceId}/queue/${r.id}/${action}`, {})
      const text =
        action === 'import'
          ? `Import started${res.files ? ` (${res.files} file${res.files === 1 ? '' : 's'})` : ''}.`
          : action === 'redownload'
            ? 'Removed, blocklisted, and searching again.'
            : 'Removed.'
      setActionState((s) => ({ ...s, [r.id]: { busy: null, result: { ok: true, text } } }))
      if (action !== 'import') setRows((rs) => rs.filter((row) => (row as { id: number }).id !== r.id))
    } catch (err) {
      setActionState((s) => ({ ...s, [r.id]: { busy: null, result: { ok: false, text: err instanceof ApiError ? err.message : 'Failed' } } }))
    }
  }

  const queueCols =
    serviceType === 'radarr' ? cols(radarrQueueColumns(runQueueAction, actionState)) : cols(queueColumns(runQueueAction, actionState))

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
          <PageSpinner className="py-6" />
        ) : (
          <DataTable
            key={subTab}
            columns={subTab === 'queue' ? queueCols : config.history}
            rows={rows as Row[]}
            rowKey={(r) => r.id}
            emptyMessage={subTab === 'queue' ? 'Nothing in the queue.' : 'No history yet.'}
            initialQuery={itemFilter}
            initialFilterScope={itemFilter ? [config.filterParam] : []}
          />
        )}
      </div>
    </div>
  )
}
