import clsx from 'clsx'
import { useNavigate } from 'react-router-dom'

export interface CalendarEvent {
  id: number
  series?: string
  series_id: number | null
  season_number: number | null
  episode: string
  air_date: string | null
  has_file: boolean
  monitored: boolean
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

// The actual grid: a month at a time, one cell per day, events plotted on
// their air date rather than listed as rows. Shared by the Calendar tab
// (all series for a service) and the series header's Calendar modal (one
// series) — `showSeries` controls whether each event line names its show.
export default function CalendarGrid({
  month, events, showSeries = false, serviceId, onNavigate,
}: {
  month: Date
  events: CalendarEvent[]
  showSeries?: boolean
  serviceId: string
  onNavigate?: () => void
}) {
  const navigate = useNavigate()
  const year = month.getFullYear()
  const monthIndex = month.getMonth()
  const firstOfMonth = new Date(year, monthIndex, 1)
  const startDay = firstOfMonth.getDay() // 0 = Sunday
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate()
  const today = new Date()

  const cells: (Date | null)[] = []
  for (let i = 0; i < startDay; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, monthIndex, d))
  while (cells.length % 7 !== 0) cells.push(null)

  const byDay = new Map<string, CalendarEvent[]>()
  for (const ev of events) {
    if (!ev.air_date) continue
    const d = new Date(ev.air_date)
    if (Number.isNaN(d.getTime())) continue
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    const list = byDay.get(key) ?? []
    list.push(ev)
    byDay.set(key, list)
  }

  return (
    <div>
      <div className="grid grid-cols-7 text-xs text-slate-500 mb-1">
        {WEEKDAYS.map((w) => (
          <div key={w} className="text-center py-1">{w}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((date, i) => {
          if (!date) return <div key={i} className="min-h-[80px] rounded-lg bg-transparent" />
          const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
          const dayEvents = byDay.get(key) ?? []
          const isToday = isSameDay(date, today)
          return (
            <div
              key={i}
              className={clsx(
                'min-h-[80px] rounded-lg border p-1.5 flex flex-col gap-1',
                isToday ? 'border-violet-600/50 bg-violet-600/5' : 'border-slate-800 bg-slate-950',
              )}
            >
              <span className={clsx('text-xs', isToday ? 'text-violet-300 font-semibold' : 'text-slate-500')}>
                {date.getDate()}
              </span>
              <div className="flex flex-col gap-0.5 overflow-hidden">
                {dayEvents.map((ev) => (
                  <span
                    key={ev.id}
                    role={ev.series_id != null ? 'link' : undefined}
                    tabIndex={ev.series_id != null ? 0 : undefined}
                    title={showSeries ? `${ev.series} — ${ev.episode}` : ev.episode}
                    onClick={() => {
                      if (ev.series_id == null) return
                      const seasonQuery = ev.season_number != null ? `?season=${ev.season_number}` : ''
                      onNavigate?.()
                      navigate(`/services/${serviceId}/series/${ev.series_id}${seasonQuery}`)
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' || ev.series_id == null) return
                      const seasonQuery = ev.season_number != null ? `?season=${ev.season_number}` : ''
                      onNavigate?.()
                      navigate(`/services/${serviceId}/series/${ev.series_id}${seasonQuery}`)
                    }}
                    className={clsx(
                      'text-[11px] leading-tight px-1 py-0.5 rounded truncate',
                      ev.has_file ? 'bg-teal-500/15 text-teal-300' : 'bg-amber-500/15 text-amber-300',
                      ev.series_id != null && 'cursor-pointer hover:underline',
                    )}
                  >
                    {showSeries ? ev.series : ev.episode}
                  </span>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
