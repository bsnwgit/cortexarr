import clsx from 'clsx'
import { useNavigate } from 'react-router-dom'
import type { ServiceAccent } from '../utils/serviceAccent'

// A service-neutral calendar entry — each caller maps its own API rows
// (Sonarr episodes, Radarr release dates) into this shape, so the grid
// itself knows nothing about series, seasons, or movies.
export interface GridEvent {
  key: string | number
  date: string | null
  label: string
  tooltip: string
  hasFile: boolean
  href: string | null
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

// The actual grid: a month at a time, one cell per day, events plotted on
// their date rather than listed as rows. Shared by every Calendar tab and
// the series header's Calendar modal. Entries and "today" use the
// service's own accent.
export default function CalendarGrid({
  month, events, accent, onNavigate,
}: {
  month: Date
  events: GridEvent[]
  accent: ServiceAccent
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

  const byDay = new Map<string, GridEvent[]>()
  for (const ev of events) {
    if (!ev.date) continue
    const d = new Date(ev.date)
    if (Number.isNaN(d.getTime())) continue
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    const list = byDay.get(key) ?? []
    list.push(ev)
    byDay.set(key, list)
  }

  function open(ev: GridEvent) {
    if (!ev.href) return
    onNavigate?.()
    navigate(ev.href)
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
                isToday ? clsx(accent.border, 'bg-slate-900') : 'border-slate-800 bg-slate-950',
              )}
            >
              <span className={clsx('text-xs', isToday ? clsx(accent.text, 'font-semibold') : 'text-slate-500')}>
                {date.getDate()}
              </span>
              <div className="flex flex-col gap-0.5 overflow-hidden">
                {dayEvents.map((ev) => (
                  <span
                    key={ev.key}
                    role={ev.href ? 'link' : undefined}
                    tabIndex={ev.href ? 0 : undefined}
                    title={ev.tooltip}
                    onClick={() => open(ev)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') open(ev)
                    }}
                    className={clsx(
                      'text-[11px] leading-tight px-1 py-0.5 rounded truncate',
                      accent.bg,
                      accent.text,
                      ev.href && 'cursor-pointer hover:underline',
                    )}
                  >
                    {ev.label}
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
