// Display helpers shared by the Radarr views (movie list, movie page,
// Missing tab).
import type { ServiceAccent } from './serviceAccent'

export function fmtBytes(n: number) {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

export function fmtRuntime(minutes: number) {
  if (!minutes) return ''
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h ? `${h}h ${m}m` : `${m}m`
}

export function fmtDay(v: string | null) {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString()
}

// Radarr's MovieStatusType values.
const STATUS_LABELS: Record<string, string> = {
  tba: 'TBA',
  announced: 'Announced',
  inCinemas: 'In cinemas',
  released: 'Released',
  deleted: 'Removed from TMDb',
}

export function movieStatusLabel(status: string | null) {
  return (status && STATUS_LABELS[status]) || status || ''
}

// Where a movie stands from the user's point of view — has it (in the
// service's own accent), is missing it (out, but no file), or it isn't out yet.
export function movieAvailability(
  m: { has_file: boolean; is_available: boolean },
  accent: ServiceAccent,
): { label: string; className: string } {
  if (m.has_file) return { label: 'Downloaded', className: `${accent.text} ${accent.border} ${accent.bg}` }
  if (m.is_available) return { label: 'Missing', className: 'text-amber-300 border-amber-600/40 bg-amber-600/10' }
  return { label: 'Upcoming', className: 'text-slate-300 border-slate-700' }
}
