import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import DataTable, { type Column } from './DataTable'
import ServiceIcon from './ServiceIcon'
import { getServiceAccent } from '../utils/serviceAccent'

interface Service {
  id: number
  name: string
  type: string
  enabled: boolean
  maintenance_mode: boolean
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

interface ActivityRow extends HistoryItem {
  service_id: number
  service_name: string
  service_type: string
}

// Services already known to have a real client behind `/detail/history` —
// keep in sync with app/api/services.py's _DETAIL_CLIENTS as new types land.
const HISTORY_CAPABLE_TYPES = new Set(['sonarr'])

function fmtDate(v: string | null) {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString()
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
  { key: 'series', label: 'Series / episode', render: (r) => `${r.series} — ${r.episode}` },
  { key: 'quality', label: 'Quality', render: (r) => r.quality || '—' },
]

// A cross-service activity feed — what happened recently, pipeline-wide,
// merged from each service's own history. Shared by the Dashboard (a quick
// glance) and Logs > Activities (the fuller log, alongside Audit Log).
export default function ActivityFeed({ limit = 50 }: { limit?: number }) {
  const [activity, setActivity] = useState<ActivityRow[]>([])
  const [hasServices, setHasServices] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function load() {
    setError('')
    try {
      const services = await api.get<Service[]>('/services/')
      setHasServices(services.length > 0)

      const capable = services.filter((s) => HISTORY_CAPABLE_TYPES.has(s.type))
      const results = await Promise.all(
        capable.map(async (s) => {
          try {
            const rows = await api.get<HistoryItem[]>(`/services/${s.id}/detail/history`)
            return rows.map((r) => ({ ...r, service_id: s.id, service_name: s.name, service_type: s.type }))
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

  if (loading) return <p className="text-slate-500 text-sm">Loading…</p>
  if (error) return <p className="text-red-300 text-sm">{error}</p>
  if (hasServices === false) {
    return (
      <p className="text-slate-500 text-sm">
        No services configured yet — add one under <Link to="/services" className="underline hover:text-slate-300">Services</Link>.
      </p>
    )
  }
  if (activity.length === 0) return <p className="text-slate-500 text-sm">No recent activity yet.</p>

  return (
    <DataTable
      columns={ACTIVITY_COLUMNS}
      rows={activity}
      rowKey={(r) => `${r.service_id}-${r.id}`}
      emptyMessage="No recent activity yet."
    />
  )
}
