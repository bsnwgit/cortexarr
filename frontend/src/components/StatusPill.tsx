import clsx from 'clsx'

export interface StatusInfo {
  maintenance_mode: boolean
  status: 'ok' | 'warning' | 'error' | 'unreachable' | null
}

const STATUS_STYLES: Record<string, string> = {
  ok: 'bg-teal-500/15 text-teal-300 border-teal-500/30',
  warning: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  error: 'bg-red-500/15 text-red-300 border-red-500/30',
  unreachable: 'bg-red-500/15 text-red-300 border-red-500/30',
}

// Shared by the Dashboard's (former) service cards and the Services page's
// list rows — a service's status should read identically wherever it's
// shown, not just on the page originally built to show it.
export default function StatusPill({ service }: { service: StatusInfo }) {
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
