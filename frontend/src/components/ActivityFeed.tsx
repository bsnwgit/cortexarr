import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import DataTable, { type Column } from './DataTable'
import ServiceIcon from './ServiceIcon'
import { getServiceAccent } from '../utils/serviceAccent'
import { fmtDateTime } from '../utils/time'
import PageSpinner from './PageSpinner'

interface Service {
  id: number
  name: string
  type: string
  enabled: boolean
  maintenance_mode: boolean
}

// The union of Sonarr's (series/episode) and Radarr's (movie/year) history
// rows — each type only fills its own half.
interface HistoryItem {
  id: number
  event_type: string
  series?: string
  episode?: string
  movie?: string
  year?: number | null
  title?: string
  source_title: string | null
  quality: string
  date: string | null
}

interface ActivityRow extends HistoryItem {
  service_id: number
  service_name: string
  service_type: string
  title: string
}

// Services already known to have a real client behind `/detail/history` —
// keep in sync with app/api/services.py's _DETAIL_CLIENTS as new types land.
const HISTORY_CAPABLE_TYPES = new Set(['sonarr', 'radarr', 'seerr', 'nzbget', 'sabnzbd'])

// The category filter's pipelines, by service type — including the planned
// ones, so each option appears on its own once a service of that type is
// configured, with no change needed here.
const CATEGORIES: { key: string; label: string; types: string[] }[] = [
  { key: 'series', label: 'Series (Sonarr)', types: ['sonarr'] },
  { key: 'movies', label: 'Movies (Radarr)', types: ['radarr'] },
  { key: 'requests', label: 'Requests (Seerr)', types: ['seerr'] },
  { key: 'downloads', label: 'Downloads (NZBGet / SABnzbd)', types: ['nzbget', 'sabnzbd'] },
]

// What the row is about, in one line, whatever the service type.
function rowTitle(r: HistoryItem): string {
  if (r.title) return r.title
  if (r.movie !== undefined) return r.year ? `${r.movie} (${r.year})` : r.movie
  return `${r.series ?? ''} — ${r.episode ?? ''}`
}

function fmtDate(v: string | null) {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? v : fmtDateTime(d)
}

const ACTIVITY_COLUMNS: Column<ActivityRow>[] = [
  { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) },
  {
    key: 'service_name',
    label: 'Service',
    filterKey: 'service_name',
    render: (r) => {
      const accent = getServiceAccent(r.service_type)
      return (
        <Link to={`/services/${r.service_id}`} className={`flex items-center gap-1.5 hover:underline ${accent.text}`}>
          <ServiceIcon type={r.service_type} className="w-4 h-4 rounded-sm shrink-0" />
          {r.service_name}
        </Link>
      )
    },
  },
  { key: 'event_type', label: 'Event', className: 'capitalize' },
  { key: 'title', label: 'Title' },
  { key: 'quality', label: 'Quality', render: (r) => r.quality || '—' },
]

// A cross-service activity feed — what happened recently, pipeline-wide,
// merged from each service's own history. Shared by the Dashboard (a quick
// glance) and Logs > Activities (the fuller log, alongside Audit Log).
export default function ActivityFeed({ limit = 50 }: { limit?: number }) {
  const [activity, setActivity] = useState<ActivityRow[]>([])
  const [hasServices, setHasServices] = useState<boolean | null>(null)
  const [configuredTypes, setConfiguredTypes] = useState<Set<string>>(new Set())
  const [category, setCategory] = useState('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function load() {
    setError('')
    try {
      const services = await api.get<Service[]>('/services/')
      setHasServices(services.length > 0)
      setConfiguredTypes(new Set(services.map((s) => s.type)))

      const capable = services.filter((s) => HISTORY_CAPABLE_TYPES.has(s.type))
      const results = await Promise.all(
        capable.map(async (s) => {
          try {
            const rows = await api.get<HistoryItem[]>(`/services/${s.id}/detail/history`)
            return rows.map((r) => ({
              ...r,
              service_id: s.id,
              service_name: s.name,
              service_type: s.type,
              title: rowTitle(r),
            }))
          } catch {
            return [] // one unreachable service shouldn't blank the whole feed
          }
        }),
      )
      const merged = results
        .flat()
        .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
        .slice(0, limit)
      setActivity(merged)
    } catch (err) {
      setError('Failed to load activity')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const interval = setInterval(load, 20000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit])

  if (loading) return <PageSpinner />
  if (error) return <p className="text-red-300 text-sm">{error}</p>
  if (hasServices === false) {
    return (
      <p className="text-slate-500 text-sm">
        No services configured yet — add one under <Link to="/services" className="underline hover:text-slate-300">Services</Link>.
      </p>
    )
  }
  if (activity.length === 0) return <p className="text-slate-500 text-sm">No recent activity yet.</p>

  const available = CATEGORIES.filter((c) => c.types.some((t) => configuredTypes.has(t)))
  const selected = available.find((c) => c.key === category)
  const rows = selected ? activity.filter((r) => selected.types.includes(r.service_type)) : activity

  return (
    <DataTable
      columns={ACTIVITY_COLUMNS}
      rows={rows}
      rowKey={(r) => `${r.service_id}-${r.id}`}
      emptyMessage={selected ? `No recent ${selected.key} activity.` : 'No recent activity yet.'}
      toolbar={
        <select
          value={selected ? category : 'all'}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-lg bg-slate-950 border border-slate-800 px-2 py-1.5 text-sm text-slate-100"
        >
          <option value="all">All activity</option>
          {available.map((c) => (
            <option key={c.key} value={c.key}>{c.label}</option>
          ))}
        </select>
      }
    />
  )
}
