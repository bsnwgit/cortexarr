import { useEffect, useState } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { api } from '../api/client'
import PageSpinner from '../components/PageSpinner'
import { fmtDuration } from '../utils/downloadFormat'

interface UptimeDay { date: string; total: number; ok: number; uptime_pct: number | null }
interface UptimeService {
  service_id: number; service_name: string; service_type: string
  overall_uptime_pct: number | null; days: UptimeDay[]
}
interface UptimeResponse { days: number; services: UptimeService[] }

interface AlertsResponse {
  days: number
  by_day: { day: string; n: number }[]
  by_rule: { rule_name: string; n: number }[]
  by_service: { service_name: string; n: number }[]
}

interface RequestsResponse {
  days: number
  by_day: { day: string; n: number }[]
  by_media_type: { media_type: string; n: number; avg_duration_seconds: number | null }[]
  summary: { n: number; avg_duration_seconds: number | null }
}

const RANGES = [
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
]

const AXIS_TICK = { fill: '#94a3b8', fontSize: 11 }
const GRID_STROKE = '#1e293b'
const TOOLTIP_STYLE = {
  background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 12, color: '#e2e8f0',
}

// History and trends (scope #4) — reporting over time, beyond the live
// dashboard/tracking views. Uptime and alert charts read straight from
// health_snapshots/alert_log; request completions come from a periodic
// scan (app/history.py) since nothing else remembers when a request
// crossed into "available".
export default function History() {
  const [days, setDays] = useState(30)
  const [uptime, setUptime] = useState<UptimeResponse | null>(null)
  const [alertsData, setAlertsData] = useState<AlertsResponse | null>(null)
  const [requests, setRequests] = useState<RequestsResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      api.get<UptimeResponse>(`/history/uptime?days=${days}`),
      api.get<AlertsResponse>(`/history/alerts?days=${days}`),
      api.get<RequestsResponse>(`/history/requests?days=${days}`),
    ])
      .then(([u, a, r]) => {
        if (cancelled) return
        setUptime(u)
        setAlertsData(a)
        setRequests(r)
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [days])

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-100">History and trends</h1>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.value}
              onClick={() => setDays(r.value)}
              className={
                'px-3 py-1.5 rounded-lg text-sm border transition-colors ' +
                (days === r.value
                  ? 'bg-violet-600/20 text-violet-300 border-violet-600/40'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900 border-transparent')
              }
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <PageSpinner />
      ) : (
        <div className="flex flex-col lg:flex-row gap-6 items-start">
          <div className="w-full lg:w-1/3">
            <UptimeSection data={uptime} />
          </div>
          <div className="w-full lg:w-2/3 space-y-6">
            <RequestsSection data={requests} />
            <AlertsSection data={alertsData} />
          </div>
        </div>
      )}
    </div>
  )
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-925 border border-slate-800 rounded-xl p-4 space-y-3">
      <h2 className="text-sm font-medium text-slate-100">{title}</h2>
      {children}
    </div>
  )
}

function UptimeSection({ data }: { data: UptimeResponse | null }) {
  if (!data || data.services.length === 0) {
    return (
      <SectionCard title="Service uptime">
        <p className="text-xs text-slate-400">No services yet.</p>
      </SectionCard>
    )
  }
  return (
    <SectionCard title="Service uptime">
      <div className="flex flex-col gap-3">
        {data.services.map((s) => (
          <div key={s.service_id} className="border border-slate-800 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-100 truncate">{s.service_name}</span>
              <span className={s.overall_uptime_pct == null ? 'text-xs text-slate-400' : s.overall_uptime_pct >= 99 ? 'text-xs text-teal-300' : s.overall_uptime_pct >= 95 ? 'text-xs text-amber-300' : 'text-xs text-red-300'}>
                {s.overall_uptime_pct == null ? 'No data' : `${s.overall_uptime_pct}%`}
              </span>
            </div>
            <div className="h-16">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={s.days}>
                  <Area type="monotone" dataKey="uptime_pct" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.2} strokeWidth={1.5} isAnimationActive={false} />
                  <YAxis hide domain={[0, 100]} />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    labelStyle={{ color: '#94a3b8' }}
                    formatter={(v: number) => [`${v}%`, 'Uptime']}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  )
}

function AlertsSection({ data }: { data: AlertsResponse | null }) {
  if (!data) return null
  const total = data.by_day.reduce((sum, d) => sum + d.n, 0)
  return (
    <SectionCard title="Alert frequency">
      {total === 0 ? (
        <p className="text-xs text-slate-400">No alerts fired in this range.</p>
      ) : (
        <>
          <div className="h-40">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.by_day}>
                <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                <XAxis dataKey="day" tick={AXIS_TICK} tickLine={false} axisLine={false} />
                <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} width={28} />
                <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#94a3b8' }} />
                <Bar dataKey="n" name="Alerts" fill="#f87171" radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 text-xs">
            <div>
              <div className="text-slate-400 mb-1">Most active rules</div>
              {data.by_rule.slice(0, 5).map((r) => (
                <div key={r.rule_name} className="flex justify-between text-slate-200 py-0.5">
                  <span className="truncate">{r.rule_name || '(unnamed rule)'}</span>
                  <span className="text-slate-400">{r.n}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="text-slate-400 mb-1">Most alerted services</div>
              {data.by_service.slice(0, 5).map((s) => (
                <div key={s.service_name} className="flex justify-between text-slate-200 py-0.5">
                  <span className="truncate">{s.service_name}</span>
                  <span className="text-slate-400">{s.n}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </SectionCard>
  )
}

function RequestsSection({ data }: { data: RequestsResponse | null }) {
  if (!data) return null
  return (
    <SectionCard title="Requests completed">
      {data.summary.n === 0 ? (
        <p className="text-xs text-slate-400">
          Nothing completed in this range yet — this fills in going forward from when this page shipped; past
          completions weren't recorded.
        </p>
      ) : (
        <>
          <div className="flex gap-6 text-sm">
            <div>
              <div className="text-2xl text-slate-100">{data.summary.n}</div>
              <div className="text-xs text-slate-400">completed</div>
            </div>
            <div>
              <div className="text-2xl text-slate-100">{fmtDuration(data.summary.avg_duration_seconds ?? null)}</div>
              <div className="text-xs text-slate-400">avg. time to available</div>
            </div>
            {data.by_media_type.map((m) => (
              <div key={m.media_type}>
                <div className="text-2xl text-slate-100">{m.n}</div>
                <div className="text-xs text-slate-400 capitalize">{m.media_type === 'tv' ? 'TV' : m.media_type}</div>
              </div>
            ))}
          </div>
          <div className="h-40">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.by_day}>
                <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                <XAxis dataKey="day" tick={AXIS_TICK} tickLine={false} axisLine={false} />
                <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} width={28} />
                <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#94a3b8' }} />
                <Bar dataKey="n" name="Completed" fill="#2dd4bf" radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </SectionCard>
  )
}
