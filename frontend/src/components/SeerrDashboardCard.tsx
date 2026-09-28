import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { api } from '../api/client'
import ServiceIcon from './ServiceIcon'
import OpenServiceLink from './OpenServiceLink'
import RefreshButton, { useRefresh } from './RefreshButton'
import StatusPill, { type StatusInfo } from './StatusPill'
import { getServiceAccent } from '../utils/serviceAccent'
import { REQUEST_STATE_LABELS, requestStateClass, type RequestState } from '../utils/seerrFormat'

interface SeerrRequest {
  id: number
  title: string
  year: number | null
  poster_url: string
  backdrop_url: string
  is_4k: boolean
  requested_by: string
  state: RequestState
}

interface DashboardService extends StatusInfo {
  id: number
  name: string
  type: string
  base_url?: string
}

const MAX_TILES = 14
// Needs-attention states lead the strip, in this order; everything else
// follows newest-first.
const ATTENTION: RequestState[] = ['failed', 'pending', 'processing']

// The dashboard's Seerr band — full width above the other pipelines,
// since requests are where everything else starts. A header with counts
// (each linking to the filtered Requests/Issues tab) over a strip of
// request posters, needs-attention first.
export default function SeerrDashboardCard({ service }: { service: DashboardService }) {
  const navigate = useNavigate()
  const accent = getServiceAccent(service.type)
  const [requests, setRequests] = useState<SeerrRequest[]>([])
  const [openIssues, setOpenIssues] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)
  const { tick, refreshing, refresh, done } = useRefresh()

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [reqs, issues] = await Promise.all([
          api.get<SeerrRequest[]>(`/services/${service.id}/detail/requests`),
          api.get<unknown[]>(`/services/${service.id}/detail/issues`),
        ])
        if (cancelled) return
        setRequests(reqs)
        setOpenIssues(issues.length)
      } catch {
        // Unreachable/bad key — the status pill already says so.
        if (!cancelled) {
          setRequests([])
          setOpenIssues(null)
        }
      } finally {
        if (!cancelled) {
          setLoaded(true)
          done()
        }
      }
    }
    load()
    const interval = setInterval(load, 30000)
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

  const requestsTab = (state?: RequestState) => `/services/${service.id}?tab=requests${state ? `&status=${state}` : ''}`
  const count = (s: RequestState) => requests.filter((r) => r.state === s).length
  const tiles = [
    ...ATTENTION.flatMap((s) => requests.filter((r) => r.state === s)),
    ...requests.filter((r) => !ATTENTION.includes(r.state)),
  ].slice(0, MAX_TILES)
  const backdrop = tiles.find((r) => r.backdrop_url)?.backdrop_url ?? ''

  const counts: { state: RequestState; label: string; className: string }[] = [
    { state: 'pending', label: 'pending approval', className: 'text-amber-300' },
    { state: 'processing', label: 'processing', className: accent.text },
    { state: 'failed', label: 'failed', className: 'text-red-300' },
  ]

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => navigate(`/services/${service.id}`)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') navigate(`/services/${service.id}`)
      }}
      className={clsx(
        'relative bg-slate-925 border border-slate-800 rounded-xl overflow-hidden transition-colors cursor-pointer',
        accent.hoverBorder,
      )}
    >
      {backdrop && <img src={backdrop} alt="" className="absolute inset-0 w-full h-full object-cover opacity-20" />}
      <div className="absolute inset-0 bg-gradient-to-r from-slate-925 via-slate-925/90 to-slate-925/70" />

      <div className="relative p-4 flex flex-col gap-3">
        {/* Name left, request counts centred, actions far right like the
            other cards; on a phone the counts drop to their own row. */}
        <div className="flex flex-wrap sm:flex-nowrap items-center gap-2">
          <span className="order-1 flex-1 min-w-0 flex items-center gap-2 font-medium text-slate-100">
            <ServiceIcon type={service.type} className="w-6 h-6 rounded-sm shrink-0" />
            {service.name}
          </span>
          {loaded && (
            <div className="order-3 sm:order-2 w-full sm:w-auto flex flex-wrap justify-center gap-1.5">
              {counts.map((c) => (
                <span
                  key={c.state}
                  {...linkProps(requestsTab(c.state))}
                  className={clsx('metadata-pill text-xs hover:underline cursor-pointer', count(c.state) > 0 ? c.className : 'text-slate-400')}
                >
                  {count(c.state)} {c.label}
                </span>
              ))}
              <span
                {...linkProps(`/services/${service.id}?tab=issues`)}
                className={clsx('metadata-pill text-xs hover:underline cursor-pointer', openIssues ? 'text-amber-300' : 'text-slate-400')}
              >
                {openIssues ?? '—'} issue{openIssues === 1 ? '' : 's'}
              </span>
            </div>
          )}
          <span className="order-2 sm:order-3 flex-1 flex items-center justify-end gap-1.5">
            <RefreshButton onRefresh={refresh} refreshing={refreshing} label={`Refresh ${service.name}`} />
            <OpenServiceLink url={service.base_url} name={service.name} />
            <StatusPill service={service} accent={accent} serviceId={service.id} />
          </span>
        </div>

        {!loaded ? null : tiles.length === 0 ? (
          <span className="text-xs text-slate-400">No requests yet</span>
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-1">
            {tiles.map((r) => (
              <div
                key={r.id}
                {...linkProps(requestsTab(r.state))}
                title={`${r.title}${r.year ? ` (${r.year})` : ''}${r.requested_by ? ` — requested by ${r.requested_by}` : ''}`}
                className="w-28 shrink-0 flex flex-col gap-1.5 cursor-pointer group"
              >
                <div className="relative w-28 h-[168px] rounded-lg overflow-hidden border border-slate-800 bg-slate-900 group-hover:border-slate-600 transition-colors">
                  {r.poster_url ? (
                    <img src={r.poster_url} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <span className="absolute inset-0 flex items-center justify-center text-xs text-slate-400 text-center px-2">
                      {r.title}
                    </span>
                  )}
                  {r.is_4k && (
                    <span className="absolute top-1 right-1 text-[10px] px-1 rounded bg-slate-950/80 border border-slate-700 text-slate-200">
                      4K
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-100 truncate">
                  {r.title}
                  {r.year ? <span className="text-slate-400"> {r.year}</span> : null}
                </p>
                <span className={clsx('self-start text-[11px] px-1.5 py-0.5 rounded border whitespace-nowrap', requestStateClass(r.state, accent))}>
                  {REQUEST_STATE_LABELS[r.state]}
                </span>
                {r.requested_by && <span className="text-[11px] text-slate-400 truncate">by {r.requested_by}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
