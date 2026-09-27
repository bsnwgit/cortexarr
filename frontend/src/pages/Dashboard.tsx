import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import ServiceCard, { type DashboardService } from '../components/ServiceCard'
import PageSpinner from '../components/PageSpinner'

const FULL_WIDTH_TYPES = new Set(['seerr'])

// One card per monitored service — Sonarr's shows fan art from whatever
// it's currently downloading plus state pills (active/queue/missing), not
// a log and not just a name. The full activity log lives under
// Logs > Activities; this page just links into each service.
export default function Dashboard() {
  const [services, setServices] = useState<DashboardService[]>([])
  const [loading, setLoading] = useState(true)

  async function load() {
    // /status/ is public and deliberately has no URLs; the signed-in
    // service list supplies each card's link to the app itself.
    const [data, list] = await Promise.all([
      api.get<{ overall: string; services: DashboardService[] }>('/status/'),
      api.get<{ id: number; base_url: string }[]>('/services/').catch(() => []),
    ])
    const urls = new Map(list.map((s) => [s.id, s.base_url]))
    setServices(data.services.map((s) => ({ ...s, base_url: urls.get(s.id) })))
    setLoading(false)
  }

  useEffect(() => {
    load()
    const interval = setInterval(load, 15000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div>
      <h2 className="text-lg font-semibold text-slate-100 mb-4">Pipeline</h2>

      {loading ? (
        <PageSpinner />
      ) : services.length === 0 ? (
        <p className="text-slate-500 text-sm">
          No services configured yet — <Link to="/settings/services?add=1" className="underline hover:text-slate-300">add one</Link>.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Requests are where the pipeline starts, so Seerr runs full
              width above the per-service cards. */}
          {services
            .filter((s) => FULL_WIDTH_TYPES.has(s.type))
            .map((s) => (
              <ServiceCard key={s.id} service={s} />
            ))}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {services
              .filter((s) => !FULL_WIDTH_TYPES.has(s.type))
              .map((s) => (
                <ServiceCard key={s.id} service={s} />
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
