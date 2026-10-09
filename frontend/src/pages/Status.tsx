import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { api } from '../api/client'
import PageSpinner from '../components/PageSpinner'
import RefreshButton, { useRefresh } from '../components/RefreshButton'
import ServiceIcon from '../components/ServiceIcon'
import { fmtBytes, fmtDuration, fmtSpeed, fmtWhen } from '../utils/downloadFormat'
import { getServiceAccent } from '../utils/serviceAccent'

// ---- response shapes (app/api/stats.py) ------------------------------------

interface ArrStats {
  kind: 'arr'
  version: string
  started_at: string | null
  disks: { path: string; label: string; free_bytes: number; total_bytes: number }[]
  queue: { total: number; errors: boolean; warnings: boolean } | null
  history: Record<string, { grabbed: number; imported: number; failed: number }>
  history_sampled: number
  // Where the media lives: each root folder's free space (total from its mount).
  library_folders?: { path: string; accessible: boolean; free_bytes: number | null; total_bytes: number | null }[]
  library: {
    noun: string; items: number; monitored: number
    file_noun: string; files: number; files_total: number; size_bytes: number
  } | null
  // Sections that couldn't be read, with why — the rest still shows.
  notes: string[]
  // Seconds each call took — shows which one is slow.
  timings?: Record<string, number>
}

interface VolumeStats {
  total_bytes: number
  today_bytes: number
  week_bytes: number
  month_bytes: number
  year_bytes: number
  articles_success: number
  articles_failed: number
  completion_pct: number | null
  seconds: number[]
  minutes: number[]
  hours: number[]
  days: { date: string; bytes: number }[]
}

interface NewsServer extends VolumeStats {
  id: number | string
  name: string
  host: string
  connections: number | null
  active: boolean | null
}

interface DownloadStats {
  kind: 'download'
  client: string
  uptime_seconds: number | null
  totals: VolumeStats | null
  servers: NewsServer[]
}

interface RequestStats {
  kind: 'requests'
  counts: Record<string, number>
}

interface ServiceStats {
  service_id: number
  name: string
  type: string
  ok: boolean
  error?: string
  took_ms?: number
  stats?: ArrStats | DownloadStats | RequestStats
  loading?: boolean
}

// Chart strokes per service type (hex because Recharts takes colors as props,
// as History.tsx does) — the same hues as serviceAccent.ts.
const CHART_COLOR: Record<string, string> = {
  nzbget: '#34d399', sabnzbd: '#fb923c', sonarr: '#2dd4bf', radarr: '#facc15', seerr: '#818cf8',
}

const AXIS_TICK = { fill: '#94a3b8', fontSize: 11 }
const GRID_STROKE = '#1e293b'
const TOOLTIP_STYLE = {
  background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 12, color: '#e2e8f0',
}

// Seerr first, then the download clients, then Sonarr and Radarr.
const ORDER: Record<string, number> = { seerr: 0, nzbget: 1, sabnzbd: 2, sonarr: 3, radarr: 4 }

interface ServiceRef { id: number; name: string; type: string }

// The Status page — one tab per service, each showing that service's own
// numbers live (not stored). Only the open tab is read, so a slow service
// never holds up the others. See app/api/stats.py.
export default function Status() {
  const [services, setServices] = useState<ServiceRef[] | null>(null)
  const [results, setResults] = useState<Record<number, ServiceStats>>({})
  const [error, setError] = useState('')
  const [params, setParams] = useSearchParams()
  const { tick, refreshing, refresh, done } = useRefresh()

  useEffect(() => {
    let cancelled = false
    api
      .get<(ServiceRef & { enabled: boolean })[]>('/services/')
      .then((list) => {
        if (cancelled) return
        setServices(
          list
            .filter((s) => s.enabled)
            .sort((a, b) => (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9) || a.name.localeCompare(b.name)),
        )
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Could not load status'))
    return () => {
      cancelled = true
    }
  }, [])

  const activeId = Number(params.get('service')) || services?.[0]?.id

  // Refresh forgets what was read, so every tab reads fresh when opened.
  useEffect(() => {
    if (tick > 0) setResults({})
  }, [tick])

  useEffect(() => {
    const svc = services?.find((s) => s.id === activeId)
    if (!svc || results[svc.id]) {
      done()
      return
    }
    let cancelled = false
    api
      .get<ServiceStats>(`/stats/${svc.id}${tick > 0 ? '?fresh=true' : ''}`)
      .catch((e): ServiceStats => ({
        service_id: svc.id, name: svc.name, type: svc.type, ok: false,
        error: e instanceof Error ? e.message : 'Could not load',
      }))
      .then((res) => {
        if (!cancelled) setResults((cur) => ({ ...cur, [svc.id]: res }))
      })
      .finally(() => {
        if (!cancelled) done()
      })
    return () => {
      cancelled = true
    }
  }, [services, activeId, results, tick, done])

  const active = services?.find((s) => s.id === activeId)

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-100">Status</h1>
        <RefreshButton onRefresh={refresh} refreshing={refreshing} label="Refresh status" />
      </div>

      {error && <p className="text-sm text-red-300">{error}</p>}
      {!services && !error ? (
        <PageSpinner />
      ) : services && services.length === 0 ? (
        <p className="text-sm text-slate-400">No services yet — add one under Settings → Services.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1">
            {services?.map((s) => {
              const accent = getServiceAccent(s.type)
              return (
                <button
                  key={s.id}
                  onClick={() => setParams({ service: String(s.id) }, { replace: true })}
                  className={clsx(
                    'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm border transition-colors',
                    s.id === activeId
                      ? clsx(accent.bg, accent.text, accent.border)
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900 border-transparent',
                  )}
                >
                  <ServiceIcon type={s.type} className="w-4 h-4" />
                  {s.name}
                </button>
              )
            })}
          </div>
          {active && <ServiceSection svc={results[active.id] ?? { service_id: active.id, name: active.name, type: active.type, ok: false, loading: true }} />}
        </>
      )}
    </div>
  )
}

function ServiceSection({ svc }: { svc: ServiceStats }) {
  const accent = getServiceAccent(svc.type)
  return (
    <section className="bg-slate-925 border border-slate-800 rounded-xl overflow-hidden">
      <div className={clsx('flex items-center gap-2 px-4 py-3 bg-gradient-to-r', accent.band)}>
        <ServiceIcon type={svc.type} className="w-5 h-5" />
        <h2 className="text-sm font-medium text-slate-100">{svc.name}</h2>
        <span className="text-xs text-slate-400 capitalize">{svc.type}</span>
      </div>
      <div className="p-4 space-y-4">
        {svc.loading ? (
          <PageSpinner className="py-6" />
        ) : !svc.ok || !svc.stats ? (
          <p className="text-sm text-red-300">{svc.error || 'No statistics available'}</p>
        ) : svc.stats.kind === 'arr' ? (
          <ArrBlock s={svc.stats} />
        ) : svc.stats.kind === 'download' ? (
          <DownloadBlock s={svc.stats} color={CHART_COLOR[svc.type] ?? '#8b5cf6'} />
        ) : (
          <RequestBlock s={svc.stats} />
        )}
      </div>
    </section>
  )
}

function Tile({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'bad' | 'warn' | 'good' }) {
  return (
    <div className="border border-slate-800 rounded-lg px-3 py-2 min-w-[7rem]">
      <div
        className={clsx(
          'text-lg',
          tone === 'bad' ? 'text-red-300' : tone === 'warn' ? 'text-amber-300' : tone === 'good' ? 'text-teal-300' : 'text-slate-100',
        )}
      >
        {value}
      </div>
      <div className="text-xs text-slate-400">{label}</div>
    </div>
  )
}

function pct(n: number | null) {
  return n == null ? '—' : `${n}%`
}

// ---- Sonarr / Radarr -------------------------------------------------------

function ArrBlock({ s }: { s: ArrStats }) {
  const lib = s.library
  // A disk that is one of the media library folders already shows under
  // "Media library space" — same path, or the same mount (same total and free).
  const folders = s.library_folders ?? []
  const otherDisks = s.disks.filter(
    (d) => !folders.some((f) => f.path === d.path || (f.total_bytes === d.total_bytes && f.free_bytes === d.free_bytes)),
  )
  return (
    <>
      <div className="flex flex-wrap gap-3">
        <Tile label="Version" value={s.version || '—'} />
        {s.started_at && <Tile label="Running since" value={<span className="text-sm">{fmtWhen(s.started_at)}</span>} />}
        {s.queue && <Tile label="In queue" value={s.queue.total} />}
        {s.queue?.errors && <Tile label="Queue" value="Errors" tone="bad" />}
        {s.queue?.warnings && <Tile label="Queue" value="Warnings" tone="warn" />}
      </div>

      {s.timings && (
        <p className="text-xs text-slate-400">
          Read in: {Object.entries(s.timings).map(([k, v]) => `${k} ${v}s`).join(' · ')}
        </p>
      )}
      {(s.notes ?? []).map((n) => (
        <p key={n} className="text-xs text-amber-300">Couldn't read — {n}</p>
      ))}

      {lib && (
        <div className="flex flex-wrap gap-3">
          <Tile label={`${lib.noun} in library`} value={lib.items} />
          <Tile label="Monitored" value={lib.monitored} />
          <Tile label={`${lib.file_noun} on disk`} value={`${lib.files} / ${lib.files_total}`} />
          <Tile label="Size on disk" value={fmtBytes(lib.size_bytes)} />
        </div>
      )}

      {Object.keys(s.history ?? {}).length > 0 && (
      <div>
        <div className="text-xs text-slate-400 mb-1">Activity (from the last {s.history_sampled} history records)</div>
        <table className="text-sm text-slate-200">
          <thead>
            <tr className="text-xs text-slate-400 text-left">
              <th className="pr-6 font-normal py-1" />
              <th className="pr-6 font-normal">Grabbed</th>
              <th className="pr-6 font-normal">Imported</th>
              <th className="font-normal">Failed</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(s.history).map(([days, c]) => (
              <tr key={days}>
                <td className="pr-6 py-0.5 text-slate-400">Last {days} days</td>
                <td className="pr-6">{c.grabbed}</td>
                <td className="pr-6">{c.imported}</td>
                <td className={c.failed ? 'text-red-300' : ''}>{c.failed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}

      {(s.library_folders ?? []).length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-slate-400">Media library space</div>
          {(s.library_folders ?? []).map((f) => (
            <SpaceRow key={f.path} name={f.path} free={f.free_bytes} total={f.total_bytes} note={f.accessible ? '' : 'not accessible'} />
          ))}
        </div>
      )}

      {otherDisks.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-slate-400">Disk space</div>
          {otherDisks.map((d) => (
            <SpaceRow key={d.path} name={d.label || d.path} free={d.free_bytes} total={d.total_bytes} />
          ))}
        </div>
      )}
    </>
  )
}

function SpaceRow({ name, free, total, note }: { name: string; free: number | null; total: number | null; note?: string }) {
  const used = total && free != null ? Math.round(100 * (1 - free / total)) : null
  return (
    <div className="text-sm">
      <div className="flex justify-between gap-3 text-slate-200">
        <span className="truncate">{name}{note ? ` (${note})` : ''}</span>
        <span className="text-slate-400 whitespace-nowrap">
          {free == null ? 'free space unknown' : total ? `${fmtBytes(free)} free of ${fmtBytes(total)}` : `${fmtBytes(free)} free`}
        </span>
      </div>
      {used != null && (
        <div className="h-1.5 bg-slate-800 rounded-full mt-1">
          <div
            className={clsx('h-1.5 rounded-full', used >= 95 ? 'bg-red-400' : used >= 85 ? 'bg-amber-400' : 'bg-teal-400')}
            style={{ width: `${used}%` }}
          />
        </div>
      )}
    </div>
  )
}

// ---- Seerr -----------------------------------------------------------------

function RequestBlock({ s }: { s: RequestStats }) {
  const c = s.counts
  return (
    <div className="flex flex-wrap gap-3">
      <Tile label="Requests" value={c.total} />
      <Tile label="Movies" value={c.movie} />
      <Tile label="TV" value={c.tv} />
      <Tile label="Pending" value={c.pending} tone={c.pending ? 'warn' : undefined} />
      <Tile label="Approved" value={c.approved} />
      <Tile label="Processing" value={c.processing} />
      <Tile label="Available" value={c.available} tone="good" />
      <Tile label="Declined" value={c.declined} />
    </div>
  )
}

// ---- NZBGet / SABnzbd ------------------------------------------------------

function DownloadBlock({ s, color }: { s: DownloadStats; color: string }) {
  return (
    <>
      {s.uptime_seconds != null && <div className="text-xs text-slate-400">Up {fmtDuration(s.uptime_seconds)}</div>}
      {s.totals && (
        <div>
          <div className="text-xs text-slate-400 mb-1">All servers</div>
          <VolumeTiles v={s.totals} />
        </div>
      )}
      {s.servers.map((srv) => (
        <ServerBlock key={srv.id} srv={srv} color={color} />
      ))}
    </>
  )
}

function VolumeTiles({ v }: { v: VolumeStats }) {
  const articles = v.articles_success + v.articles_failed
  return (
    <div className="flex flex-wrap gap-3">
      <Tile label="Today" value={fmtBytes(v.today_bytes)} />
      <Tile label="Last 7 days" value={fmtBytes(v.week_bytes)} />
      <Tile label="Last 30 days" value={fmtBytes(v.month_bytes)} />
      <Tile label="Last 365 days" value={fmtBytes(v.year_bytes)} />
      <Tile label="Total" value={fmtBytes(v.total_bytes)} />
      {articles > 0 && (
        <>
          <Tile label="Articles OK" value={v.articles_success.toLocaleString()} />
          <Tile label="Articles failed" value={v.articles_failed.toLocaleString()} tone={v.articles_failed ? 'bad' : undefined} />
          <Tile
            label="Completion"
            value={pct(v.completion_pct)}
            tone={v.completion_pct != null && v.completion_pct < 90 ? 'warn' : 'good'}
          />
        </>
      )}
    </div>
  )
}

function ServerBlock({ srv, color }: { srv: NewsServer; color: string }) {
  return (
    <div className="border border-slate-800 rounded-lg p-3 space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-sm text-slate-100">{srv.name}</span>
        {srv.host && srv.host !== srv.name && <span className="text-xs text-slate-400">{srv.host}</span>}
        {srv.connections != null && <span className="text-xs text-slate-400">{srv.connections} connections</span>}
        {srv.active != null && (
          <span
            className={clsx(
              'text-xs px-2 py-0.5 rounded-full border',
              srv.active ? 'text-teal-300 border-teal-600/40' : 'text-red-300 border-red-600/40',
            )}
          >
            {srv.active ? 'Active' : 'Inactive'}
          </span>
        )}
      </div>
      <VolumeTiles v={srv} />
      <VolumeChart v={srv} color={color} />
    </div>
  )
}

type Range = 'seconds' | 'minutes' | 'hours' | 'days'
const RANGE_LABEL: Record<Range, string> = { seconds: '60 seconds', minutes: '60 minutes', hours: '24 hours', days: '30 days' }
const RANGE_SECONDS: Record<Range, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 }

// Speed is the data in each slot over the slot's length; Data is the bytes
// in each slot. NZBGet keeps all four ranges; SABnzbd only daily totals, so
// the other buttons don't show for it.
function VolumeChart({ v, color }: { v: VolumeStats; color: string }) {
  const available = (['seconds', 'minutes', 'hours', 'days'] as Range[]).filter((r) =>
    r === 'days' ? v.days.length > 0 : v[r].length > 0,
  )
  const [range, setRange] = useState<Range>(available[0] ?? 'days')
  const [mode, setMode] = useState<'speed' | 'data'>(available[0] === 'days' ? 'data' : 'speed')
  if (available.length === 0) return null

  const per = RANGE_SECONDS[range]
  const raw: { label: string; bytes: number }[] =
    range === 'days'
      ? v.days.map((d) => ({ label: d.date, bytes: d.bytes }))
      : v[range].map((b, i, arr) => ({ label: `-${arr.length - 1 - i}${range === 'seconds' ? 's' : range === 'minutes' ? 'm' : 'h'}`, bytes: b }))
  const speed = mode === 'speed'
  const data = raw.map((p) => ({ label: p.label, value: speed ? p.bytes / per : p.bytes }))
  const fmt = (n: number) => (speed ? fmtSpeed(n) : fmtBytes(n))
  const peak = Math.max(0, ...data.map((d) => d.value))

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          {(['speed', 'data'] as const).map((m) => (
            <ToggleButton key={m} active={mode === m} onClick={() => setMode(m)}>
              {m === 'speed' ? 'Speed' : 'Data'}
            </ToggleButton>
          ))}
        </div>
        <div className="flex gap-1">
          {available.map((r) => (
            <ToggleButton key={r} active={range === r} onClick={() => setRange(r)}>
              {RANGE_LABEL[r]}
            </ToggleButton>
          ))}
        </div>
        <span className="text-xs text-slate-400">Peak {fmt(peak)}</span>
      </div>
      <div className="h-44">
        <ResponsiveContainer width="100%" height="100%">
          {speed ? (
            <AreaChart data={data}>
              <CartesianGrid stroke={GRID_STROKE} vertical={false} />
              <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} minTickGap={32} />
              <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={72} tickFormatter={fmt} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#94a3b8' }} formatter={(x: number) => [fmt(x), 'Speed']} />
              <Area type="monotone" dataKey="value" stroke={color} fill={color} fillOpacity={0.2} strokeWidth={1.5} isAnimationActive={false} />
            </AreaChart>
          ) : (
            <BarChart data={data}>
              <CartesianGrid stroke={GRID_STROKE} vertical={false} />
              <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} minTickGap={32} />
              <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={72} tickFormatter={fmt} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#94a3b8' }} formatter={(x: number) => [fmt(x), 'Data']} />
              <Bar dataKey="value" fill={color} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function ToggleButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'px-2.5 py-1 rounded-lg text-xs border transition-colors',
        active
          ? 'bg-violet-600/20 text-violet-300 border-violet-600/40'
          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900 border-transparent',
      )}
    >
      {children}
    </button>
  )
}
