import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { api } from '../api/client'
import ServiceIcon from './ServiceIcon'
import OpenServiceLink from './OpenServiceLink'
import RefreshButton, { useRefresh } from './RefreshButton'
import StatusPill, { type StatusInfo } from './StatusPill'
import type { DownloadOverviewData } from './DownloadOverview'
import { getServiceAccent } from '../utils/serviceAccent'
import { fmtBytes, fmtDuration, fmtSpeed } from '../utils/downloadFormat'

interface QueueItem {
  id: number | string
  name: string
  state_label: string
  progress_pct: number | null
  eta_seconds: number | null
  paused: boolean
  active: boolean
}

interface HistoryItem {
  id: number | string
  name: string
  outcome: string
  date: string | null
  reason: string
}

interface DashboardService extends StatusInfo {
  id: number
  name: string
  type: string
  base_url?: string
}

const MAX_CARDS = 4
const RECENT_FAILURE_HOURS = 24

// The dashboard's download-client card (NZBGet, SABnzbd): speed / left / free disk up top, then a
// nested card per item in the queue (progress bar) and per download that
// failed in the last day (with its reason).
export default function DownloadClientCard({ service }: { service: DashboardService }) {
  const navigate = useNavigate()
  const accent = getServiceAccent(service.type)
  const [overview, setOverview] = useState<DownloadOverviewData | null>(null)
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [failures, setFailures] = useState<HistoryItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const { tick, refreshing, refresh, done } = useRefresh()

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [ov, q, h] = await Promise.all([
          api.get<DownloadOverviewData>(`/services/${service.id}/detail/overview`),
          api.get<QueueItem[]>(`/services/${service.id}/detail/queue`),
          api.get<HistoryItem[]>(`/services/${service.id}/detail/history`),
        ])
        if (cancelled) return
        const since = Date.now() - RECENT_FAILURE_HOURS * 3600 * 1000
        setOverview(ov)
        setQueue(q)
        setFailures(h.filter((x) => x.outcome === 'failure' && x.date && new Date(x.date).getTime() >= since))
      } catch {
        // Unreachable/bad login — the status pill already says so.
        if (!cancelled) {
          setOverview(null)
          setQueue([])
          setFailures([])
        }
      } finally {
        if (!cancelled) {
          setLoaded(true)
          done()
        }
      }
    }
    load()
    const interval = setInterval(load, 15000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [service.id, tick, done])

  function linkProps(to: string) {
    const go = (e: MouseEvent | KeyboardEvent) => {
      e.stopPropagation()
      navigate(to)
    }
    return {
      role: 'link' as const,
      tabIndex: 0,
      onClick: go,
      onKeyDown: (e: KeyboardEvent) => e.key === 'Enter' && go(e),
    }
  }

  const queueCards = queue.slice(0, MAX_CARDS)
  const failureCards = failures.slice(0, Math.max(0, MAX_CARDS - queueCards.length) || 2)
  const moreQueue = queue.length - queueCards.length

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => navigate(`/services/${service.id}`)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') navigate(`/services/${service.id}`)
      }}
      className={clsx(
        'bg-slate-925 border border-slate-800 rounded-xl overflow-hidden transition-colors cursor-pointer',
        accent.hoverBorder,
      )}
    >
      <div className="px-3 pt-3 flex items-center justify-between">
        <span className="flex items-center gap-2 font-medium text-slate-100 text-sm">
          <ServiceIcon type={service.type} className="w-5 h-5 rounded-sm shrink-0" />
          {service.name}
        </span>
        <span className="flex items-center gap-1.5">
          <RefreshButton onRefresh={refresh} refreshing={refreshing} label={`Refresh ${service.name}`} />
          <OpenServiceLink url={service.base_url} name={service.name} />
          <StatusPill service={service} accent={accent} />
        </span>
      </div>

      {overview && (
        <div className="px-3 pt-2 flex flex-wrap gap-1.5">
          <span className={clsx('metadata-pill text-xs', overview.paused ? 'text-amber-300' : accent.text)}>
            {overview.paused ? 'Paused' : `↓ ${fmtSpeed(overview.download_rate)}`}
          </span>
          <span className="metadata-pill text-xs">
            {fmtBytes(overview.remaining_bytes)} left{overview.eta_seconds != null ? ` · ${fmtDuration(overview.eta_seconds)}` : ''}
          </span>
          <span className="metadata-pill text-xs">{fmtBytes(overview.free_disk_bytes)} free</span>
        </div>
      )}

      <div className="p-3 flex flex-col gap-2">
        {!loaded ? null : queueCards.length === 0 && failureCards.length === 0 ? (
          <span className="text-xs text-slate-400">Nothing downloading, no recent failures</span>
        ) : (
          <>
            {queueCards.map((q) => (
              <div
                key={`q-${q.id}`}
                {...linkProps(`/services/${service.id}?tab=queue`)}
                className="rounded-lg border border-slate-800 bg-slate-950/60 p-2 cursor-pointer hover:border-slate-700 flex flex-col gap-1.5"
              >
                <p className={clsx('text-xs font-medium truncate', q.active ? accent.text : 'text-slate-100')} title={q.name}>
                  {q.active ? '▶ ' : ''}
                  {q.name}
                </p>
                <div className="flex items-center gap-2">
                  <span className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <span className={clsx('block h-full bg-current', accent.text)} style={{ width: `${q.progress_pct ?? 0}%` }} />
                  </span>
                  <span className="text-[11px] text-slate-300">{q.progress_pct ?? 0}%</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={clsx('metadata-pill text-[11px]', q.paused && 'text-amber-300')}>{q.state_label}</span>
                  {q.eta_seconds != null && <span className="text-[11px] text-slate-400">{fmtDuration(q.eta_seconds)}</span>}
                </div>
              </div>
            ))}
            {failureCards.map((f) => (
              <div
                key={`f-${f.id}`}
                {...linkProps(`/services/${service.id}?tab=history`)}
                className="rounded-lg border border-slate-800 bg-slate-950/60 p-2 cursor-pointer hover:border-slate-700 flex flex-col gap-1"
              >
                <p className="text-xs font-medium truncate text-slate-100" title={f.name}>{f.name}</p>
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="metadata-pill text-[11px] text-red-300 shrink-0">Failed</span>
                  {f.reason && <span className="text-[11px] text-slate-400 truncate" title={f.reason}>{f.reason}</span>}
                </div>
              </div>
            ))}
            {moreQueue > 0 && (
              <span
                {...linkProps(`/services/${service.id}?tab=queue`)}
                className="text-xs text-slate-400 hover:text-slate-200 hover:underline cursor-pointer self-start"
              >
                +{moreQueue} more in queue
              </span>
            )}
          </>
        )}
      </div>
    </div>
  )
}
