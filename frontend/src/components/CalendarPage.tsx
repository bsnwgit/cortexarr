import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, ApiError } from '../api/client'
import CalendarGrid, { type GridEvent } from './CalendarGrid'
import { getServiceAccent } from '../utils/serviceAccent'

function monthRange(month: Date): { start: string; end: string } {
  const start = new Date(month.getFullYear(), month.getMonth(), 1)
  const end = new Date(month.getFullYear(), month.getMonth() + 1, 0)
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
}

// ?month=YYYY-MM opens the grid on that month (e.g. from a movie's release
// date pill); anything else falls back to the current month.
function initialMonth(param: string | null): Date {
  const m = param?.match(/^(\d{4})-(\d{2})$/)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, 1)
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1)
}

interface SonarrCalendarRow {
  id: number
  series: string
  series_id: number | null
  season_number: number | null
  episode: string
  air_date: string | null
  has_file: boolean
}

interface RadarrCalendarRow {
  id: string
  movie_id: number | null
  title: string
  year: number | null
  release_type: string
  date: string | null
  has_file: boolean
}

// Each service type's calendar rows → the grid's neutral event shape.
const TO_GRID_EVENTS: Record<string, (serviceId: string, rows: unknown[]) => GridEvent[]> = {
  sonarr: (serviceId, rows) =>
    (rows as SonarrCalendarRow[]).map((r) => ({
      key: r.id,
      date: r.air_date,
      label: r.series,
      tooltip: `${r.series} — ${r.episode}`,
      hasFile: r.has_file,
      href:
        r.series_id != null
          ? `/services/${serviceId}/series/${r.series_id}${r.season_number != null ? `?season=${r.season_number}` : ''}`
          : null,
    })),
  radarr: (serviceId, rows) =>
    (rows as RadarrCalendarRow[]).map((r) => ({
      key: r.id,
      date: r.date,
      label: r.title,
      tooltip: `${r.title}${r.year ? ` (${r.year})` : ''} — ${r.release_type}`,
      hasFile: r.has_file,
      href: r.movie_id != null ? `/services/${serviceId}/movies/${r.movie_id}` : null,
    })),
}

// The Calendar tab — a real month grid across the whole service (missing
// episodes for Sonarr, release dates for Radarr), not a list. One page
// (month) at a time.
export default function CalendarPage({ serviceId, serviceType }: { serviceId: string; serviceType: string }) {
  const [searchParams] = useSearchParams()
  const [month, setMonth] = useState(() => initialMonth(searchParams.get('month')))
  const [events, setEvents] = useState<GridEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const toEvents = TO_GRID_EVENTS[serviceType]
    async function load() {
      setLoading(true)
      setError('')
      try {
        const { start, end } = monthRange(month)
        const data = await api.get<unknown[]>(`/services/${serviceId}/calendar?start=${start}&end=${end}`)
        if (!cancelled) setEvents(toEvents ? toEvents(serviceId, data) : [])
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [serviceId, serviceType, month])

  const label = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

  return (
    <div className="bg-slate-925 border border-slate-800 rounded-xl p-3 sm:p-4">
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
          className="btn-secondary"
        >
          ← Prev
        </button>
        <h3 className="text-sm font-medium text-slate-100">{label}</h3>
        <button
          onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
          className="btn-secondary"
        >
          Next →
        </button>
      </div>

      {error ? (
        <p className="text-red-300 text-sm py-6 text-center">{error}</p>
      ) : loading ? (
        <p className="text-slate-500 text-sm py-6 text-center">Loading…</p>
      ) : (
        <CalendarGrid month={month} events={events} accent={getServiceAccent(serviceType)} />
      )}
    </div>
  )
}
