import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import ServiceCard, { type DashboardService } from '../components/ServiceCard'

// One card per monitored service — Sonarr's shows fan art from whatever
// it's currently downloading plus state pills (active/queue/missing), not
// a log and not just a name. The full activity log lives under
// Logs > Activities; this page just links into each service.
export default function Dashboard() {
  const [services, setServices] = useState<DashboardService[]>([])
  const [loading, setLoading] = useState(true)

  async function load() {
    const data = await api.get<{ overall: string; services: DashboardService[] }>('/status/')
    setServices(data.services)
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
        <p className="text-slate-500 text-sm">Loading…</p>
      ) : services.length === 0 ? (
        <p className="text-slate-500 text-sm">
          No services configured yet — add one under <Link to="/services" className="underline hover:text-slate-300">Services</Link>.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {services.map((s) => (
            <ServiceCard key={s.id} service={s} />
          ))}
        </div>
      )}
    </div>
  )
}
