import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { api } from '../api/client'
import ServiceIcon from '../components/ServiceIcon'

interface StatusService {
  id: number
  name: string
  type: string
  enabled: boolean
  maintenance_mode: boolean
  status: 'ok' | 'warning' | 'error' | 'unreachable' | null
  connectivity_ok: boolean | null
  checked_at: string | null
}

const STATUS_STYLES: Record<string, string> = {
  ok: 'bg-teal-500/15 text-teal-300 border-teal-500/30',
  warning: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  error: 'bg-red-500/15 text-red-300 border-red-500/30',
  unreachable: 'bg-red-500/15 text-red-300 border-red-500/30',
}

function StatusPill({ service }: { service: StatusService }) {
  if (service.maintenance_mode) {
    return <span className="text-xs px-2 py-1 rounded-lg border border-slate-700 text-slate-400">Maintenance</span>
  }
  if (!service.status) {
    return <span className="text-xs px-2 py-1 rounded-lg border border-slate-700 text-slate-400">Checking…</span>
  }
  // Connectivity failure reads differently from an app-reported issue (scope #8)
  const label =
    service.status === 'unreachable'
      ? 'Unreachable'
      : service.status === 'ok'
        ? 'Healthy'
        : service.status === 'warning'
          ? 'Warning'
          : 'Error'
  return (
    <span className={clsx('text-xs px-2 py-1 rounded-lg border', STATUS_STYLES[service.status])}>{label}</span>
  )
}

export default function Dashboard() {
  const [services, setServices] = useState<StatusService[]>([])
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [loading, setLoading] = useState(true)

  async function load() {
    const data = await api.get<{ overall: string; services: StatusService[] }>('/status/')
    setServices(data.services)
    setLoading(false)
  }

  useEffect(() => {
    load()
    const interval = setInterval(load, 15000)
    return () => clearInterval(interval)
  }, [])

  const filtered = services.filter((s) => {
    if (typeFilter && s.type !== typeFilter) return false
    if (query && !s.name.toLowerCase().includes(query.toLowerCase())) return false
    return true
  })

  const types = Array.from(new Set(services.map((s) => s.type)))

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-3 mb-4 sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold text-slate-100">Pipeline health</h2>
        <div className="flex gap-2">
          <input
            placeholder="Search services…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="rounded-lg bg-slate-925 border border-slate-800 px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-violet-500 w-full sm:w-56"
          />
          {types.length > 1 && (
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="rounded-lg bg-slate-925 border border-slate-800 px-2 py-1.5 text-sm text-slate-100"
            >
              <option value="">All types</option>
              {types.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {loading ? (
        <p className="text-slate-500 text-sm">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-slate-500 text-sm">
          {services.length === 0 ? 'No services configured yet — add one under Services.' : 'No services match.'}
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((s) => (
            <Link
              key={s.id}
              to={`/services/${s.id}`}
              className="block bg-slate-925 border border-slate-800 rounded-xl p-4 hover:border-violet-600/40 transition-colors"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="flex items-center gap-2 font-medium text-slate-100">
                  <ServiceIcon type={s.type} className="w-5 h-5 rounded-sm shrink-0" />
                  {s.name}
                </span>
                <StatusPill service={s} />
              </div>
              <div className="text-xs text-slate-500 flex justify-between">
                <span className="capitalize">{s.type}</span>
                <span>{s.checked_at ? new Date(s.checked_at + 'Z').toLocaleTimeString() : '—'}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
