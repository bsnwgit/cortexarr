// Per-service-type accent, so a service's own section of the dashboard reads
// in that service's own brand color instead of the app's global violet —
// e.g. Sonarr's teal (the color at the center of its own icon/app). The app
// chrome (header, login, nav) stays violet; only service-specific UI (its
// dashboard card, its detail page's tabs) picks up the accent. Unmapped
// types fall back to the app's violet, same as before any type had its own.
export interface ServiceAccent {
  text: string
  bg: string
  border: string
  hoverBorder: string
  // Gradient stops for the tinted header band on the service's own page.
  band: string
}

const DEFAULT_ACCENT: ServiceAccent = {
  text: 'text-violet-300',
  bg: 'bg-violet-600/20',
  border: 'border-violet-600/40',
  hoverBorder: 'hover:border-violet-600/40',
  band: 'from-violet-600/25 via-violet-600/10 to-transparent',
}

const ACCENTS: Record<string, ServiceAccent> = {
  sonarr: {
    text: 'text-teal-300',
    bg: 'bg-teal-600/20',
    border: 'border-teal-600/40',
    hoverBorder: 'hover:border-teal-600/40',
    band: 'from-teal-600/25 via-teal-600/10 to-transparent',
  },
  // Radarr's gold (#FFC230, the wedge in its own mark).
  radarr: {
    text: 'text-yellow-300',
    bg: 'bg-yellow-500/15',
    border: 'border-yellow-500/40',
    hoverBorder: 'hover:border-yellow-500/40',
    band: 'from-yellow-500/25 via-yellow-500/10 to-transparent',
  },
  // Seerr's indigo (#4F65F5, the deep end of its purple-to-indigo mark).
  seerr: {
    text: 'text-indigo-300',
    bg: 'bg-indigo-500/15',
    border: 'border-indigo-500/40',
    hoverBorder: 'hover:border-indigo-500/40',
    band: 'from-indigo-500/25 via-indigo-500/10 to-transparent',
  },
  // NZBGet's green (#2eb12b, the ring of its own mark).
  nzbget: {
    text: 'text-emerald-300',
    bg: 'bg-emerald-500/15',
    border: 'border-emerald-500/40',
    hoverBorder: 'hover:border-emerald-500/40',
    band: 'from-emerald-500/25 via-emerald-500/10 to-transparent',
  },
  // SABnzbd's orange (#FFB300, its arrow mark) — orange rather than
  // yellow/amber, which are Radarr's gold and the warning color.
  sabnzbd: {
    text: 'text-orange-300',
    bg: 'bg-orange-500/15',
    border: 'border-orange-500/40',
    hoverBorder: 'hover:border-orange-500/40',
    band: 'from-orange-500/25 via-orange-500/10 to-transparent',
  },
}

export function getServiceAccent(type: string): ServiceAccent {
  return ACCENTS[type] ?? DEFAULT_ACCENT
}
