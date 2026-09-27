// Display helpers for download-client views (NZBGet, and any other client
// that lands later).

export function fmtBytes(n: number | null | undefined) {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function fmtSpeed(bytesPerSec: number | null | undefined) {
  return bytesPerSec ? `${fmtBytes(bytesPerSec)}/s` : '0 B/s'
}

export function fmtDuration(seconds: number | null | undefined) {
  if (seconds == null) return '—'
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

// Release names are one long dotted word; a zero-width space after each
// dot lets them wrap at the dots instead of mid-word.
export function wrapName(name: string) {
  return name.replace(/\./g, '.​')
}

export function fmtWhen(v: string | null) {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString()
}

// History outcomes (the part of NZBGet's Status before the slash).
export const OUTCOME_LABELS: Record<string, string> = {
  success: 'Success',
  warning: 'Warning',
  failure: 'Failed',
  deleted: 'Deleted',
}

export function outcomeClass(outcome: string, accentClasses: string) {
  if (outcome === 'failure') return 'text-red-300 border-red-600/40 bg-red-600/10'
  if (outcome === 'warning') return 'text-amber-300 border-amber-600/40 bg-amber-600/10'
  if (outcome === 'deleted') return 'text-slate-300 border-slate-700'
  return accentClasses
}
