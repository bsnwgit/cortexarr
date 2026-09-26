import { useEffect, useState } from 'react'
import { api, ApiError } from '../api/client'
import CalendarGrid, { type CalendarEvent } from './CalendarGrid'

function monthRange(month: Date): { start: string; end: string } {
  const start = new Date(month.getFullYear(), month.getMonth(), 1)
  const end = new Date(month.getFullYear(), month.getMonth() + 1, 0)
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
}

// The Calendar tab — a real month grid (missing episodes across every
// series for this service), not a list. One page (month) at a time.
export default function CalendarPage({ serviceId }: { serviceId: string }) {
  const [month, setMonth] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError('')
      try {
        const { start, end } = monthRange(month)
        const data = await api.get<CalendarEvent[]>(`/services/${serviceId}/calendar?start=${start}&end=${end}`)
        if (!cancelled) setEvents(data)
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
  }, [serviceId, month])

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
        <CalendarGrid month={month} events={events} showSeries serviceId={serviceId} />
      )}
    </div>
  )
}
