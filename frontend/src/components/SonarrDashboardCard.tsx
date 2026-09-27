import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { api } from '../api/client'
import ServiceIcon from './ServiceIcon'
import OpenServiceLink from './OpenServiceLink'
import RefreshButton, { useRefresh } from './RefreshButton'
import StatusPill, { type StatusInfo } from './StatusPill'
import { fmtState } from './DownloadingPanel'
import { getServiceAccent } from '../utils/serviceAccent'

interface QueueItem {
  id: number
  series_id: number | null
  series: string
  episode: string
  progress_pct: number | null
  status: string
  tracked_status: string | null
  tracked_state: string | null
}

interface WantedItem {
  id: number
  series_id: number | null
  series: string
  season_number: number | null
  episode_number: number | null
}

interface SeriesArt {
  id: number
  title: string
  poster_url: string
  fanart_url: string
}

interface DashboardService extends StatusInfo {
  id: number
  name: string
  type: string
  base_url?: string
}

// Per series with missing episodes: how many, and where the earliest one is.
interface MissingSeries {
  seriesId: number
  title: string
  count: number
  firstSeason: number | null
}

const MAX_CARDS = 5
const FAILED_STATES = new Set(['failed', 'failedPending', 'importBlocked'])

function isStuck(q: QueueItem) {
  return q.tracked_status === 'warning' || q.tracked_status === 'error' || FAILED_STATES.has(q.tracked_state ?? '')
}

// The dashboard's Sonarr card, in the same shape as Radarr's: a nested card
// per episode that's stuck, then per episode downloading, then per series
// with missing episodes (not already downloading) — so every series that
// needs attention shows up, not just the ones in the queue.
export default function SonarrDashboardCard({ service }: { service: DashboardService }) {
  const navigate = useNavigate()
  const accent = getServiceAccent(service.type)
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [missing, setMissing] = useState<MissingSeries[]>([])
  const [seriesById, setSeriesById] = useState<Map<number, SeriesArt>>(new Map())
  const [loaded, setLoaded] = useState(false)
  const { tick, refreshing, refresh, done } = useRefresh()

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
        const bySeries = new Map<number, MissingSeries & { firstEpisode: number }>()
        for (const w of wanted) {
          if (w.series_id == null) continue
          const cur = bySeries.get(w.series_id) ?? {
            seriesId: w.series_id, title: w.series, count: 0, firstSeason: null, firstEpisode: 0,
          }
          cur.count += 1
          // Earliest (lowest season/episode) gap, so the link lands on it.
          if (
            w.season_number != null &&
            (cur.firstSeason == null || w.season_number < cur.firstSeason ||
              (w.season_number === cur.firstSeason && (w.episode_number ?? 0) < cur.firstEpisode))
          ) {
            cur.firstSeason = w.season_number
            cur.firstEpisode = w.episode_number ?? 0
          }
          bySeries.set(w.series_id, cur)
        }
        setQueue(queueData)
        setMissing(Array.from(bySeries.values()).sort((a, b) => b.count - a.count))
        setSeriesById(new Map(series.map((s) => [s.id, s])))
      } catch {
        // Unreachable/bad key — the status pill already says so.
        if (!cancelled) {
          setQueue([])
          setMissing([])
          setSeriesById(new Map())
        }
      } finally {
        if (!cancelled) {
          setLoaded(true)
          done()
        }
      }
    }
    load()
    const interval = setInterval(load, 20000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [service.id, tick, done])

  // Every link inside the card stops propagation so it doesn't also fire
  // the whole card's "go to the service" click.
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

  const seriesLink = (seriesId: number, season?: number | null) =>
    `/services/${service.id}/series/${seriesId}${season != null ? `?season=${season}` : ''}`

  const queueCount = new Map<number, number>()
  for (const q of queue) if (q.series_id != null) queueCount.set(q.series_id, (queueCount.get(q.series_id) ?? 0) + 1)
  const missingById = new Map(missing.map((m) => [m.seriesId, m]))

  type Card = { kind: 'queue'; item: QueueItem } | { kind: 'missing'; series: MissingSeries }
  const queued = new Set(queue.map((q) => q.series_id))
  const cards: Card[] = [
    ...queue.filter(isStuck).map((item): Card => ({ kind: 'queue', item })),
    ...queue.filter((q) => !isStuck(q)).map((item): Card => ({ kind: 'queue', item })),
    ...missing.filter((m) => !queued.has(m.seriesId)).map((series): Card => ({ kind: 'missing', series })),
  ]
  const shown = cards.slice(0, MAX_CARDS)
  const moreQueue = queue.length - shown.filter((c) => c.kind === 'queue').length
  const moreMissing = cards.filter((c) => c.kind === 'missing').length - shown.filter((c) => c.kind === 'missing').length

  const firstSeriesId = shown.map((c) => (c.kind === 'queue' ? c.item.series_id : c.series.seriesId)).find((id) => id != null)
  const bannerUrl = firstSeriesId != null ? seriesById.get(firstSeriesId)?.fanart_url ?? '' : ''

  function poster(seriesId: number | null) {
    const url = seriesId != null ? seriesById.get(seriesId)?.poster_url : undefined
    return url ? (
      <img src={url} alt="" className="w-8 h-11 rounded object-cover shrink-0 border border-slate-800" />
    ) : (
      <div className="w-8 h-11 rounded bg-slate-900 shrink-0" />
    )
  }

  function missingPill(seriesId: number | null) {
    const m = seriesId != null ? missingById.get(seriesId) : undefined
    if (!m) return null
    return (
      <span {...linkProps(seriesLink(m.seriesId, m.firstSeason))} className="metadata-pill text-amber-300 hover:underline cursor-pointer">
        {m.count} missing
      </span>
    )
  }

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
        {bannerUrl ? (
          <img src={bannerUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full bg-slate-950" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-slate-925 via-slate-925/70 to-black/20" />
        <div className="absolute inset-x-0 top-0 flex items-center justify-between px-3 py-2">
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
      </div>

      <div className="p-3 flex flex-col gap-2">
        {!loaded ? null : shown.length === 0 ? (
          <span className="text-xs text-slate-400">Nothing downloading or missing</span>
        ) : (
          <>
            {shown.map((card) =>
              card.kind === 'queue' ? (
                <div
                  key={`q-${card.item.id}`}
                  {...(card.item.series_id != null ? linkProps(seriesLink(card.item.series_id)) : {})}
                  className={clsx(
                    'flex gap-2 rounded-lg border border-slate-800 bg-slate-950/60 p-2',
                    card.item.series_id != null && 'cursor-pointer hover:border-slate-700',
                  )}
                >
                  {poster(card.item.series_id)}
                  <div className="min-w-0 flex flex-col gap-1">
                    <p className={clsx('text-xs font-medium truncate', accent.text)}>
                      ▶ {card.item.series} — {card.item.episode}
                      {card.item.progress_pct != null ? ` (${card.item.progress_pct}%)` : ''}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {isStuck(card.item) && (
                        <span
                          {...linkProps(`/services/${service.id}?tab=downloading&series=${encodeURIComponent(card.item.series)}`)}
                          className={clsx(
                            'metadata-pill hover:underline cursor-pointer',
                            card.item.tracked_status === 'error' || FAILED_STATES.has(card.item.tracked_state ?? '')
                              ? 'text-red-300'
                              : 'text-amber-300',
                          )}
                        >
                          {fmtState(card.item.tracked_state) || card.item.status}
                        </span>
                      )}
                      <span
                        {...linkProps(`/services/${service.id}?tab=downloading&series=${encodeURIComponent(card.item.series)}`)}
                        className="metadata-pill hover:underline cursor-pointer"
                      >
                        {card.item.series_id != null ? queueCount.get(card.item.series_id) ?? 1 : 1} in queue
                      </span>
                      {missingPill(card.item.series_id)}
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  key={`m-${card.series.seriesId}`}
                  {...linkProps(seriesLink(card.series.seriesId, card.series.firstSeason))}
                  className="flex gap-2 rounded-lg border border-slate-800 bg-slate-950/60 p-2 cursor-pointer hover:border-slate-700"
                >
                  {poster(card.series.seriesId)}
                  <div className="min-w-0 flex flex-col gap-1">
                    <p className="text-xs font-medium truncate text-slate-100">
                      {seriesById.get(card.series.seriesId)?.title || card.series.title}
                    </p>
                    <div className="flex flex-wrap gap-1.5">{missingPill(card.series.seriesId)}</div>
                  </div>
                </div>
              ),
            )}
            {(moreQueue > 0 || moreMissing > 0) && (
              <div className="flex flex-wrap gap-3">
                {moreQueue > 0 && (
                  <span
                    {...linkProps(`/services/${service.id}?tab=downloading`)}
                    className="text-xs text-slate-400 hover:text-slate-200 hover:underline cursor-pointer"
                  >
                    +{moreQueue} more in queue
                  </span>
                )}
                {moreMissing > 0 && (
                  <span
                    {...linkProps(`/services/${service.id}?tab=missing`)}
                    className="text-xs text-amber-300 hover:underline cursor-pointer"
                  >
                    +{moreMissing} more series missing episodes
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
