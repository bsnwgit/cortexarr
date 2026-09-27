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
  movie_id: number | null
  movie: string
  year: number | null
  poster_url: string
  fanart_url: string
  progress_pct: number | null
  tracked_status: string | null
  tracked_state: string | null
  status: string
}

interface MissingItem {
  id: number
  movie_id: number
  title: string
  year: number | null
  poster_url: string
  fanart_url: string
}

interface DashboardService extends StatusInfo {
  id: number
  name: string
  type: string
  base_url?: string
}

// One nested card per movie that needs attention, in this order.
type MovieCard =
  | { kind: 'errored' | 'downloading'; key: string; movieId: number | null; title: string; poster: string; fanart: string; item: QueueItem }
  | { kind: 'missing'; key: string; movieId: number; title: string; poster: string; fanart: string }

const MAX_CARDS = 5
const FAILED_STATES = new Set(['failed', 'failedPending', 'importBlocked'])

function isErrored(q: QueueItem) {
  return q.tracked_status === 'warning' || q.tracked_status === 'error' || FAILED_STATES.has(q.tracked_state ?? '')
}

const withYear = (title: string, year: number | null) => (year ? `${title} (${year})` : title)

// The dashboard's Radarr card: a nested card per movie that's errored,
// downloading, or missing (released, no file, not already in the queue) —
// each with its poster, state, and links to its movie page and the list it
// belongs to.
export default function RadarrDashboardCard({ service }: { service: DashboardService }) {
  const navigate = useNavigate()
  const accent = getServiceAccent(service.type)
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [missing, setMissing] = useState<MissingItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const { tick, refreshing, refresh, done } = useRefresh()

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [queueData, wanted] = await Promise.all([
          api.get<QueueItem[]>(`/services/${service.id}/detail/queue`),
          api.get<MissingItem[]>(`/services/${service.id}/detail/wanted`),
        ])
        if (cancelled) return
        setQueue(queueData)
        setMissing(wanted)
      } catch {
        // Unreachable/bad key — the status pill already says so.
        if (!cancelled) {
          setQueue([])
          setMissing([])
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

  const queued = new Set(queue.map((q) => q.movie_id))
  const missingNotQueued = missing.filter((m) => !queued.has(m.movie_id))
  const fromQueue = (q: QueueItem, kind: 'errored' | 'downloading'): MovieCard => ({
    kind, key: `q-${q.id}`, movieId: q.movie_id, title: withYear(q.movie, q.year), poster: q.poster_url, fanart: q.fanart_url, item: q,
  })
  const cards: MovieCard[] = [
    ...queue.filter(isErrored).map((q) => fromQueue(q, 'errored')),
    ...queue.filter((q) => !isErrored(q)).map((q) => fromQueue(q, 'downloading')),
    ...missingNotQueued.map((m): MovieCard => ({
      kind: 'missing', key: `m-${m.id}`, movieId: m.movie_id, title: withYear(m.title, m.year), poster: m.poster_url, fanart: m.fanart_url,
    })),
  ]
  const shown = cards.slice(0, MAX_CARDS)
  const moreQueue = queue.length - shown.filter((c) => c.kind !== 'missing').length
  const moreMissing = missingNotQueued.length - shown.filter((c) => c.kind === 'missing').length
  const bannerUrl = cards.find((c) => c.fanart)?.fanart ?? ''

  function statePill(card: MovieCard) {
    if (card.kind === 'missing') {
      return (
        <span {...linkProps(`/services/${service.id}?tab=missing`)} className="metadata-pill text-amber-300 hover:underline cursor-pointer">
          Missing
        </span>
      )
    }
    const q = card.item
    const failed = q.tracked_status === 'error' || FAILED_STATES.has(q.tracked_state ?? '')
    return (
      <span
        {...linkProps(`/services/${service.id}?tab=downloading&movie=${encodeURIComponent(q.movie)}`)}
        className={clsx(
          'metadata-pill hover:underline cursor-pointer',
          card.kind === 'errored' && (failed ? 'text-red-300' : 'text-amber-300'),
        )}
      >
        {fmtState(q.tracked_state) || q.status}
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
            {shown.map((card) => (
              <div
                key={card.key}
                {...(card.movieId != null ? linkProps(`/services/${service.id}/movies/${card.movieId}`) : {})}
                className={clsx(
                  'flex gap-2 rounded-lg border border-slate-800 bg-slate-950/60 p-2',
                  card.movieId != null && 'cursor-pointer hover:border-slate-700',
                )}
              >
                {card.poster ? (
                  <img src={card.poster} alt="" className="w-8 h-11 rounded object-cover shrink-0 border border-slate-800" />
                ) : (
                  <div className="w-8 h-11 rounded bg-slate-900 shrink-0" />
                )}
                <div className="min-w-0 flex flex-col gap-1">
                  <p className={clsx('text-xs font-medium truncate', card.kind === 'missing' ? 'text-slate-100' : accent.text)}>
                    {card.kind !== 'missing' && '▶ '}
                    {card.title}
                    {card.kind !== 'missing' && card.item.progress_pct != null ? ` — ${card.item.progress_pct}%` : ''}
                  </p>
                  <div className="flex flex-wrap gap-1.5">{statePill(card)}</div>
                </div>
              </div>
            ))}
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
                    +{moreMissing} more missing
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
