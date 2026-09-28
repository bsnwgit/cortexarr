import type { MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import type { ServiceAccent } from '../utils/serviceAccent'

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

// A problem status (not ok/maintenance/checking) is itself a link to
// Notifications -> Alerts, where "Current problems" says specifically
// what's wrong — rather than just bubbling up to whatever the card around
// it navigates to (its own service page, which doesn't say why).
const PROBLEM_STATUSES = new Set(['warning', 'error', 'unreachable'])

// Shared by the Dashboard's (former) service cards and the Services page's
// list rows — a service's status should read identically wherever it's
// shown, not just on the page originally built to show it.
// `accent` colors the Healthy state in the service's own color; warning,
// error, and unreachable stay amber/red regardless. `serviceId` narrows
// the Alerts link to just this service's own problems, when known.
export default function StatusPill({
  service, accent, serviceId,
}: { service: StatusInfo; accent?: ServiceAccent; serviceId?: number }) {
  const navigate = useNavigate()

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
  const className = clsx(
    'text-xs px-2 py-1 rounded-lg border',
    service.status === 'ok' && accent ? clsx(accent.bg, accent.text, accent.border) : STATUS_STYLES[service.status],
  )
  if (!PROBLEM_STATUSES.has(service.status)) {
    return <span className={className}>{label}</span>
  }
  function goToProblem(e: MouseEvent) {
    e.stopPropagation()
    navigate(serviceId == null ? '/alerts' : `/alerts?service=${serviceId}`)
  }
  return (
    <span
      role="link"
      tabIndex={0}
      title="See what's wrong"
      onClick={goToProblem}
      onKeyDown={(e) => e.key === 'Enter' && goToProblem(e as unknown as MouseEvent)}
      className={clsx(className, 'cursor-pointer hover:underline')}
    >
      {label}
    </span>
  )
}
