import { useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import ServiceIcon from './ServiceIcon'
import OpenServiceLink from './OpenServiceLink'
import StatusPill, { type StatusInfo } from './StatusPill'
import SonarrDashboardCard from './SonarrDashboardCard'
import RadarrDashboardCard from './RadarrDashboardCard'
import SeerrDashboardCard from './SeerrDashboardCard'
import DownloadClientCard from './DownloadClientCard'
import { getServiceAccent } from '../utils/serviceAccent'

export interface DashboardService extends StatusInfo {
  id: number
  name: string
  type: string
  base_url?: string
}

// A plain fallback for any service type without its own rich card yet —
// icon, name, status. Sonarr gets the fan-art-and-pills treatment below;
// a future type adds its own component and one entry here, same shape as
// ServiceIcon/serviceAccent.
function PlainServiceCard({ service }: { service: DashboardService }) {
  const accent = getServiceAccent(service.type)
  const navigate = useNavigate()
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => navigate(`/services/${service.id}`)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') navigate(`/services/${service.id}`)
      }}
      className={clsx('block bg-slate-925 border border-slate-800 rounded-xl p-4 transition-colors cursor-pointer', accent.hoverBorder)}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="flex items-center gap-2 font-medium text-slate-100">
          <ServiceIcon type={service.type} className="w-5 h-5 rounded-sm shrink-0" />
          {service.name}
        </span>
        <span className="flex items-center gap-1.5">
          <OpenServiceLink url={service.base_url} name={service.name} />
          <StatusPill service={service} accent={accent} serviceId={service.id} />
        </span>
      </div>
      <div className={clsx('text-xs capitalize', accent.text)}>{service.type}</div>
    </div>
  )
}

const RICH_CARDS: Record<string, (props: { service: DashboardService }) => ReactNode> = {
  sonarr: SonarrDashboardCard,
  radarr: RadarrDashboardCard,
  seerr: SeerrDashboardCard,
  nzbget: DownloadClientCard,
  sabnzbd: DownloadClientCard,
}

export default function ServiceCard({ service }: { service: DashboardService }) {
  const Rich = RICH_CARDS[service.type]
  return Rich ? <Rich service={service} /> : <PlainServiceCard service={service} />
}
