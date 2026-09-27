import { useEffect, useState } from 'react'
import { api, ApiError } from '../api/client'
import CalendarGrid, { type GridEvent } from './CalendarGrid'
import { getServiceAccent } from '../utils/serviceAccent'
import PageSpinner from './PageSpinner'

interface SeriesCalendarRow {
  id: number
  series_id: number | null
  season_number: number | null
  episode: string
  air_date: string | null
  has_file: boolean
}

function monthRange(month: Date): { start: string; end: string } {
  const start = new Date(month.getFullYear(), month.getMonth(), 1)
  const end = new Date(month.getFullYear(), month.getMonth() + 1, 0)
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
}

// The series header's Calendar button — a real month grid scoped to just
// this series, with its own month navigation (self-fetching per month,
// same shape as the top-level Calendar tab).
export default function CalendarModal({
  title, serviceId, seriesId, onClose, initialMonth,
}: {
  title: string
  serviceId: string
  seriesId: string
  onClose: () => void
  initialMonth?: Date
}) {
  const [month, setMonth] = useState(() => {
    const base = initialMonth ?? new Date()
    return new Date(base.getFullYear(), base.getMonth(), 1)
  })
  const [events, setEvents] = useState<GridEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError('')
      try {
        const { start, end } = monthRange(month)
        const data = await api.get<SeriesCalendarRow[]>(
          `/services/${serviceId}/series/${seriesId}/calendar?start=${start}&end=${end}`,
        )
        if (!cancelled) {
          setEvents(
            data.map((r) => ({
              key: r.id,
              date: r.air_date,
              label: r.episode,
              tooltip: r.episode,
              hasFile: r.has_file,
              href:
                r.series_id != null
                  ? `/services/${serviceId}/series/${r.series_id}${r.season_number != null ? `?season=${r.season_number}` : ''}`
                  : null,
            })),
          )
        }
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
  }, [serviceId, seriesId, month])

  const monthLabel = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-slate-925 border border-slate-800 rounded-xl shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <h3 className="text-base font-semibold text-slate-100">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200 text-sm">
            Close
          </button>
        </div>
        <div className="overflow-y-auto p-4">
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
              className="btn-secondary"
            >
              ← Prev
            </button>
            <h4 className="text-sm font-medium text-slate-100">{monthLabel}</h4>
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
            <PageSpinner className="py-6" />
          ) : (
            <CalendarGrid month={month} events={events} accent={getServiceAccent('sonarr')} onNavigate={onClose} />
          )}
        </div>
      </div>
    </div>
  )
}
