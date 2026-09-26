import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { api } from '../api/client'
import ServiceIcon from './ServiceIcon'
import StatusPill, { type StatusInfo } from './StatusPill'
import { getServiceAccent } from '../utils/serviceAccent'

interface QueueItem {
  id: number
  series_id: number | null
  series: string
  episode: string
  progress_pct: number | null
}

interface WantedItem {
  id: number
  series_id: number | null
  season_number: number | null
  episode_number: number | null
}

interface SeriesArt {
  id: number
  poster_url: string
  fanart_url: string
}

interface DashboardService extends StatusInfo {
  id: number
  name: string
  type: string
}

const MAX_CARDS = 4

// The dashboard's Sonarr card — one mini activity card per item actually
// downloading right now (not just the first one), each with its own
// series-scoped "in queue" / "missing" pills, plus fan art from whichever
// is on top. Falls back to a plain summary when nothing's downloading.
export default function SonarrDashboardCard({ service }: { service: DashboardService }) {
  const navigate = useNavigate()
  const accent = getServiceAccent(service.type)
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [missingBySeriesId, setMissingBySeriesId] = useState<Map<number, number>>(new Map())
  const [firstMissingSeasonBySeriesId, setFirstMissingSeasonBySeriesId] = useState<Map<number, number>>(new Map())
  const [seriesById, setSeriesById] = useState<Map<number, SeriesArt>>(new Map())
  const [totalMissing, setTotalMissing] = useState<number | null>(null)
  const [fanartUrl, setFanartUrl] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [queueData, wanted, series] = await Promise.all([
          api.get<QueueItem[]>(`/services/${service.id}/detail/queue`),
          api.get<WantedItem[]>(`/services/${service.id}/detail/wanted`),
          api.get<SeriesArt[]>(`/services/${service.id}/detail/series`),
        ])
        if (cancelled) return
        setQueue(queueData)
        setTotalMissing(wanted.length)

        const missingCounts = new Map<number, number>()
        // Earliest (lowest season/episode) missing entry per series, so the
        // "missing" pill lands on the season that actually has the gap.
        const firstMissing = new Map<number, { season: number; episode: number }>()
        for (const w of wanted) {
          if (w.series_id == null) continue
          missingCounts.set(w.series_id, (missingCounts.get(w.series_id) ?? 0) + 1)
          if (w.season_number == null) continue
          const candidate = { season: w.season_number, episode: w.episode_number ?? 0 }
          const current = firstMissing.get(w.series_id)
          if (!current || candidate.season < current.season || (candidate.season === current.season && candidate.episode < current.episode)) {
            firstMissing.set(w.series_id, candidate)
          }
        }
        setMissingBySeriesId(missingCounts)
        setFirstMissingSeasonBySeriesId(new Map(Array.from(firstMissing, ([id, v]) => [id, v.season])))
        setSeriesById(new Map(series.map((s) => [s.id, s])))

        const topSeriesId = queueData[0]?.series_id
        const match = topSeriesId != null ? series.find((s) => s.id === topSeriesId) : undefined
        setFanartUrl(match?.fanart_url ?? '')
        setLoaded(true)
      } catch {
        // Unreachable/bad key — the status pill already says so; just show
        // no highlights rather than a second error here.
        if (!cancelled) {
          setQueue([])
          setMissingBySeriesId(new Map())
          setFirstMissingSeasonBySeriesId(new Map())
          setSeriesById(new Map())
          setTotalMissing(null)
          setFanartUrl('')
          setLoaded(true)
        }
      }
    }
    load()
    const interval = setInterval(load, 20000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [service.id])

  const queueCountBySeriesId = new Map<number, number>()
  for (const q of queue) {
    if (q.series_id == null) continue
    queueCountBySeriesId.set(q.series_id, (queueCountBySeriesId.get(q.series_id) ?? 0) + 1)
  }

  const shown = queue.slice(0, MAX_CARDS)
  const extra = queue.length - shown.length

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
      <div className="relative h-20">
        {fanartUrl ? (
          <img src={fanartUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full bg-slate-950" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-slate-925 via-slate-925/70 to-black/20" />
        <div className="absolute inset-x-0 top-0 flex items-center justify-between px-3 py-2">
          <span className="flex items-center gap-2 font-medium text-slate-100 text-sm">
            <ServiceIcon type={service.type} className="w-5 h-5 rounded-sm shrink-0" />
            {service.name}
          </span>
          <StatusPill service={service} />
        </div>
      </div>

      <div className="p-3 flex flex-col gap-2">
        {!loaded ? null : shown.length === 0 ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-slate-500">Nothing downloading</span>
            {totalMissing != null && totalMissing > 0 && (
              <span
                role="link"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation()
                  navigate(`/services/${service.id}?tab=missing`)
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  e.stopPropagation()
                  navigate(`/services/${service.id}?tab=missing`)
                }}
                className="metadata-pill text-amber-300 hover:underline cursor-pointer"
              >
                {totalMissing} missing
              </span>
            )}
          </div>
        ) : (
          <>
            {shown.map((item) => {
              const queueCount = item.series_id != null ? queueCountBySeriesId.get(item.series_id) ?? 1 : 1
              const missingCount = item.series_id != null ? missingBySeriesId.get(item.series_id) ?? 0 : 0
              const posterUrl = item.series_id != null ? seriesById.get(item.series_id)?.poster_url : undefined
              const firstMissingSeason = item.series_id != null ? firstMissingSeasonBySeriesId.get(item.series_id) : undefined
              const goToSeries = (e: { stopPropagation: () => void }) => {
                e.stopPropagation()
                if (item.series_id != null) navigate(`/services/${service.id}/series/${item.series_id}`)
              }
              const goToFirstMissing = (e: { stopPropagation: () => void }) => {
                e.stopPropagation()
                if (item.series_id == null) return
                const seasonQuery = firstMissingSeason != null ? `?season=${firstMissingSeason}` : ''
                navigate(`/services/${service.id}/series/${item.series_id}${seasonQuery}`)
              }
              return (
                <div
                  key={item.id}
                  role="link"
                  tabIndex={0}
                  onClick={goToSeries}
                  onKeyDown={(e) => e.key === 'Enter' && goToSeries(e)}
                  className={clsx(
                    'flex gap-2 rounded-lg border border-slate-800 bg-slate-950/60 p-2',
                    item.series_id != null && 'cursor-pointer hover:border-slate-700',
                  )}
                >
                  {posterUrl ? (
                    <img src={posterUrl} alt="" className="w-8 h-11 rounded object-cover shrink-0 border border-slate-800" />
                  ) : (
                    <div className="w-8 h-11 rounded bg-slate-900 shrink-0" />
                  )}
                  <div className="min-w-0 flex flex-col gap-1">
                    <p className={clsx('text-xs font-medium truncate', accent.text)}>
                      ▶ {item.series} — {item.episode}
                      {item.progress_pct != null ? ` (${item.progress_pct}%)` : ''}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      <span
                        role="link"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation()
                          navigate(`/services/${service.id}?tab=downloading&series=${encodeURIComponent(item.series)}`)
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter') return
                          e.stopPropagation()
                          navigate(`/services/${service.id}?tab=downloading&series=${encodeURIComponent(item.series)}`)
                        }}
                        className="metadata-pill hover:underline cursor-pointer"
                      >
                        {queueCount} in queue
                      </span>
                      {missingCount > 0 && (
                        <span
                          role="link"
                          tabIndex={0}
                          onClick={goToFirstMissing}
                          onKeyDown={(e) => e.key === 'Enter' && goToFirstMissing(e)}
                          className={clsx(
                            'metadata-pill text-amber-300',
                            item.series_id != null && 'hover:underline cursor-pointer',
                          )}
                        >
                          {missingCount} missing
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
            {extra > 0 && (
              <span
                role="link"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation()
                  navigate(`/services/${service.id}?tab=downloading`)
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  e.stopPropagation()
                  navigate(`/services/${service.id}?tab=downloading`)
                }}
                className="text-xs text-slate-500 hover:text-slate-300 hover:underline cursor-pointer self-start"
              >
                +{extra} more in queue
              </span>
            )}
          </>
        )}
      </div>
    </div>
  )
}
