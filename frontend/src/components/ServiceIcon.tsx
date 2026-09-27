import SonarrIcon from './icons/SonarrIcon'
import RadarrIcon from './icons/RadarrIcon'
import GenericServiceIcon from './icons/GenericServiceIcon'

// One entry per service type with its own icon. Adding a new service
// (Radarr, Seerr, ...) means dropping its icon component in ./icons and
// adding one line here — every place that renders a ServiceIcon (Dashboard
// cards, ServiceDetail's header) picks it up automatically. A type with no
// entry falls back to the generic mark rather than showing nothing.
const ICONS: Record<string, typeof SonarrIcon> = {
  sonarr: SonarrIcon,
  radarr: RadarrIcon,
}

export default function ServiceIcon({ type, className = 'w-5 h-5' }: { type: string; className?: string }) {
  const Icon = ICONS[type] ?? GenericServiceIcon
  return <Icon className={className} />
}
