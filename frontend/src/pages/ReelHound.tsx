import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { api } from '../api/client'
import ServiceIcon from '../components/ServiceIcon'
import OpenServiceLink from '../components/OpenServiceLink'
import PageSpinner from '../components/PageSpinner'
import ReelhoundStatus from '../components/ReelhoundStatus'
import { getServiceAccent } from '../utils/serviceAccent'

// ReelHound's own tab, kept apart from the media pipeline like Live TV.
// Connection settings (URL, monitoring key) live in Settings → Services.

interface Service {
  id: number
  name: string
  type: string
  base_url: string
  enabled: boolean
}

export default function ReelHound() {
  const [params, setParams] = useSearchParams()
  const [services, setServices] = useState<Service[] | null>(null)

  useEffect(() => {
    api
      .get<Service[]>('/services/?type=reelhound')
      .then((s) => setServices(s.filter((x) => x.enabled)))
      .catch(() => setServices([]))
  }, [])

  const selected = services?.find((s) => String(s.id) === params.get('service')) ?? services?.[0]
  const accent = getServiceAccent('reelhound')

  if (services === null) return <PageSpinner />
  if (!selected) {
    return (
      <div className="bg-slate-925 border border-slate-800 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-slate-100 mb-2">ReelHound</h2>
        <p className="text-sm text-slate-100">No ReelHound service is enabled. An admin manages services in Settings → Services.</p>
      </div>
    )
  }

  return (
    <div>
      <div className={clsx('rounded-xl border bg-gradient-to-r px-4 py-3 mb-4', accent.band, accent.border)}>
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
            <ServiceIcon type="reelhound" className="w-6 h-6 rounded-sm shrink-0" />
            ReelHound
            {services.length > 1 ? (
              <select
                className="input w-auto ml-2"
                value={selected.id}
                onChange={(e) => setParams({ service: e.target.value }, { replace: true })}
                aria-label="ReelHound instance"
              >
                {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            ) : (
              <span className="text-sm font-normal text-slate-400">{selected.name}</span>
            )}
          </h2>
          <OpenServiceLink url={selected.base_url} name={selected.name} />
        </div>
      </div>
      <ReelhoundStatus key={selected.id} serviceId={String(selected.id)} />
    </div>
  )
}
