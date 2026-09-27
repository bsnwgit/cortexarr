import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { api } from '../api/client'
import { fmtDateTime } from '../utils/time'
import PageSpinner from '../components/PageSpinner'

interface Tracked {
  request_id: number
  title: string
  year: number | null
  media_type: 'movie' | 'tv'
  poster_url: string
  is_4k: boolean
  requested_by: string | null
  requested_at: string | null
  stage: string
  since: string | null
  progress: { have: number; of: number } | null
  detail: string
  arr: { service_id: number; service_name: string; type: 'sonarr' | 'radarr'; item_id: number; title: string } | null
  seerr_state: string
  seasons: number[]
  seerr: { service_id: number; service_name: string }
}

interface TrackingResponse {
  requests: Tracked[]
  errors: string[]
  stages: { key: string; label: string }[]
}

// Off the main line: the request hasn't failed, it just isn't moving through
// the stages (not released yet), or it has (failed), or we can't see it.
const SIDE_STAGES: Record<string, { label: string; className: string }> = {
  upcoming: { label: 'Not released yet', className: 'text-slate-300' },
  failed: { label: 'Failed in Seerr', className: 'text-red-300' },
  unknown: { label: "Can't tell", className: 'text-amber-300' },
}

function since(v: string | null) {
  if (!v) return ''
  const mins = Math.max(0, Math.round((Date.now() - new Date(v).getTime()) / 60000))
  if (mins < 60) return `${mins}m`
  if (mins < 1440) return `${Math.floor(mins / 60)}h ${mins % 60}m`
  const days = Math.floor(mins / 1440)
  return `${days}d ${Math.floor((mins % 1440) / 60)}h`
}

// Where clicking a request takes you: the place in the pipeline it's at.
function destination(r: Tracked): { href: string; label: string } {
  const seerr = `/services/${r.seerr.service_id}`
  const a = r.arr
  const itemPage = a
    ? a.type === 'sonarr'
      ? `/services/${a.service_id}/series/${a.item_id}${r.seasons.length ? `?season=${r.seasons[0]}` : ''}`
      : `/services/${a.service_id}/movies/${a.item_id}`
    : null
  switch (r.stage) {
    case 'approval':
      return { href: `${seerr}?tab=requests&status=pending`, label: `${r.seerr.service_name} requests` }
    case 'failed':
      return { href: `${seerr}?tab=issues`, label: `${r.seerr.service_name} issues` }
    case 'downloading':
    case 'importing':
      if (a) {
        const param = a.type === 'sonarr' ? 'series' : 'movie'
        return {
          href: `/services/${a.service_id}?tab=downloading&${param}=${encodeURIComponent(a.title || r.title)}`,
          label: `${a.service_name} downloads`,
        }
      }
      break
  }
  if (itemPage && a) return { href: itemPage, label: a.service_name }
  const status = r.seerr_state in { approved: 1, processing: 1 } ? `&status=${r.seerr_state}` : ''
  return { href: `${seerr}?tab=requests${status}`, label: `${r.seerr.service_name} requests` }
}

// The filter buttons: "in progress" (the default) and "all", each main-line
// stage, then the side states. Counts come from the full list.
const DONE = new Set(['available', 'failed'])
const SIDE_ORDER = ['upcoming', 'failed', 'unknown']

// A Seerr request followed through the pipeline — one row per request, a
// dot per stage, the current one lit with how long it's been there. Stalls
// alert through Alerts (the "request stalled" rules).
export default function Tracking() {
  const navigate = useNavigate()
  const [data, setData] = useState<TrackingResponse | null>(null)
  const [loading, setLoading] = useState(true)
  // Kept in the URL so a filtered view can be bookmarked or shared.
  const [params, setParams] = useSearchParams()
  const filter = params.get('stage') || 'active'
  const setFilter = (f: string) => setParams(f === 'active' ? {} : { stage: f })

  async function load() {
    try {
      setData(await api.get<TrackingResponse>('/tracking/?active_only=false'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const interval = setInterval(load, 30000)
    return () => clearInterval(interval)
  }, [])

  const stages = data?.stages ?? []
  const all = data?.requests ?? []
  const count = (f: string) =>
    f === 'all' ? all.length : f === 'active' ? all.filter((r) => !DONE.has(r.stage)).length : all.filter((r) => r.stage === f).length
  const shown = all.filter((r) => (filter === 'all' ? true : filter === 'active' ? !DONE.has(r.stage) : r.stage === filter))
  const filters = [
    { key: 'active', label: 'In progress' },
    { key: 'all', label: 'All' },
    ...stages.map((s) => ({ key: s.key, label: s.label })),
    ...SIDE_ORDER.map((k) => ({ key: k, label: SIDE_STAGES[k].label })),
  ]

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="text-lg font-semibold text-slate-100">Request tracking</h2>
        {/* Same dropdown as the other pages' filters (series library, activity). */}
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Show"
          className="rounded-lg bg-slate-950 border border-slate-800 px-2 py-1.5 text-sm text-slate-100"
        >
          {filters.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label} ({loading ? '…' : count(f.key)})
            </option>
          ))}
        </select>
      </div>

      {data?.errors.map((e) => (
        <p key={e} className="mb-2 text-sm text-amber-300 bg-amber-950/30 border border-amber-900/60 rounded-lg px-3 py-2">
          Couldn't check {e}
        </p>
      ))}

      {loading ? (
        <PageSpinner />
      ) : shown.length === 0 ? (
        <p className="text-slate-400 text-sm">
          {filter === 'active' ? 'Nothing in progress — every request is available.' : 'No requests here.'}
        </p>
      ) : (
        <div className="space-y-2">
          {shown.map((r) => {
            const idx = stages.findIndex((s) => s.key === r.stage)
            const side = SIDE_STAGES[r.stage]
            const dest = destination(r)
            return (
              <div
                key={`${r.seerr.service_id}-${r.request_id}`}
                role="link"
                tabIndex={0}
                title={`Open in ${dest.label}`}
                onClick={() => navigate(dest.href)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') navigate(dest.href)
                }}
                className="bg-slate-925 border border-slate-800 rounded-xl p-3 flex gap-3 cursor-pointer hover:border-violet-600/40 transition-colors"
              >
                {r.poster_url ? (
                  <img src={r.poster_url} alt="" className="w-12 h-[4.5rem] object-cover rounded-md shrink-0" />
                ) : (
                  <div className="w-12 h-[4.5rem] rounded-md bg-slate-900 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-100">
                      {r.title || `Request ${r.request_id}`}
                      {r.year ? ` (${r.year})` : ''}
                    </span>
                    <span className="metadata-pill text-xs">{r.media_type === 'tv' ? 'TV' : 'Movie'}</span>
                    {r.is_4k && <span className="metadata-pill text-xs">4K</span>}
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {r.requested_by ? `Requested by ${r.requested_by}` : 'Requested'}
                    {r.requested_at ? ` · ${fmtDateTime(new Date(r.requested_at))}` : ''}
                    {r.arr ? ` · ${r.arr.service_name}` : ''} ·{' '}
                    {r.seerr.service_name}
                    <span className="text-violet-300"> · Open in {dest.label} →</span>
                  </div>

                  {side ? (
                    <p className={clsx('mt-2 text-sm', side.className)}>
                      {side.label}
                      {r.detail ? ` — ${r.detail}` : ''}
                    </p>
                  ) : (
                    <ol className="mt-2 grid grid-cols-3 sm:grid-cols-6 gap-1">
                      {stages.map((s, i) => (
                        <li key={s.key} className="flex flex-col gap-1">
                          <span
                            className={clsx(
                              'h-1.5 rounded-full',
                              i < idx ? 'bg-violet-500/60' : i === idx ? (s.key === 'available' ? 'bg-teal-400' : 'bg-violet-400') : 'bg-slate-800',
                            )}
                          />
                          <span className={clsx('text-xs', i === idx ? 'text-slate-100 font-medium' : 'text-slate-400')}>
                            {s.label}
                            {i === idx && r.since && s.key !== 'available' ? ` · ${since(r.since)}` : ''}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}

                  {(r.progress || (!side && r.detail)) && (
                    <p className="mt-1 text-xs text-slate-300">
                      {r.progress ? `${r.progress.have} of ${r.progress.of} aired episodes` : ''}
                      {r.progress && r.detail && !side ? ' · ' : ''}
                      {!side ? r.detail : ''}
                    </p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
      <p className="mt-4 text-xs text-slate-400">
        To be told when a request stays too long in a stage, add a “Request …” rule under{' '}
        <Link to="/alerts" className="underline hover:text-slate-200">Alerts</Link>.
      </p>
    </div>
  )
}
