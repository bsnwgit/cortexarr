import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import ServiceIcon from './ServiceIcon'
import StatusPill, { type StatusInfo } from './StatusPill'
import SonarrDashboardCard from './SonarrDashboardCard'
import RadarrDashboardCard from './RadarrDashboardCard'
import { getServiceAccent } from '../utils/serviceAccent'

export interface DashboardService extends StatusInfo {
  id: number
  name: string
  type: string
}

// A plain fallback for any service type without its own rich card yet —
// icon, name, status. Sonarr gets the fan-art-and-pills treatment below;
// a future type adds its own component and one entry here, same shape as
// ServiceIcon/serviceAccent.
function PlainServiceCard({ service }: { service: DashboardService }) {
  const accent = getServiceAccent(service.type)
  return (
    <Link
      to={`/services/${service.id}`}
      className={clsx('block bg-slate-925 border border-slate-800 rounded-xl p-4 transition-colors', accent.hoverBorder)}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="flex items-center gap-2 font-medium text-slate-100">
          <ServiceIcon type={service.type} className="w-5 h-5 rounded-sm shrink-0" />
          {service.name}
        </span>
        <StatusPill service={service} accent={accent} />
      </div>
      <div className={clsx('text-xs capitalize', accent.text)}>{service.type}</div>
    </Link>
  )
}

const RICH_CARDS: Record<string, (props: { service: DashboardService }) => ReactNode> = {
  sonarr: SonarrDashboardCard,
  radarr: RadarrDashboardCard,
}

export default function ServiceCard({ service }: { service: DashboardService }) {
  const Rich = RICH_CARDS[service.type]
  return Rich ? <Rich service={service} /> : <PlainServiceCard service={service} />
}
