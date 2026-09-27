import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import ConfirmDeleteModal from '../components/ConfirmDeleteModal'
import ServiceIcon from '../components/ServiceIcon'
import { fmtDateTime } from '../utils/time'
import { resultText } from '../utils/notifyResult'

type Event =
  | 'unreachable'
  | 'error'
  | 'warning'
  | 'stuck'
  | 'download_failed'
  | 'request_issue'
  | 'stalled_approval'
  | 'stalled_sending'
  | 'stalled_searching'
  | 'stalled_downloading'
  | 'stalled_importing'
type Channel = 'email' | 'webhook' | 'ntfy' | 'sms'

interface Rule {
  id: number
  name: string
  enabled: boolean
  event: Event
  service_id: number | null
  threshold_minutes: number
  repeat_minutes: number
  channels: Channel[]
  notify_resolved: boolean
}

interface Problem {
  service_id: number
  service_name: string
  service_type: string
  key: string
  event: Event
  title: string
  detail: string
  first_seen: string
  snoozed: boolean
  snoozed_until: string | null
  snoozed_by: string | null
  snooze_note: string | null
  service_url: string
  advice: string
  actions: { id: string; label: string; destructive: boolean }[]
}

const rowKey = (p: Problem) => `${p.service_id}-${p.key}`
// Problems can only be picked together when their fixes are exactly the same,
// so one bulk action means the same thing for every one of them.
const fixSet = (p: Problem) => p.actions.map((a) => a.id).join(',')

// Where in the app itself to look at a problem.
function appLink(p: Problem): { href: string; label: string } | null {
  if (!/^https?:\/\//i.test(p.service_url)) return null
  const base = p.service_url.replace(/\/+$/, '')
  if (p.event === 'stuck') return { href: `${base}/activity/queue`, label: 'Open queue' }
  if (p.event === 'error' || p.event === 'warning') return { href: `${base}/system/status`, label: 'Open System → Status' }
  if (p.event === 'request_issue') return { href: `${base}/issues`, label: 'Open in Seerr' }
  if (p.event === 'download_failed') return { href: base, label: 'Open' }
  return null
}

interface LogRow {
  id: number
  sent_at: string
  rule_name: string
  service_name: string
  event: Event
  kind: 'alert' | 'resolved' | 'test' | 'digest'
  subject: string
  body: string
  results: Record<string, { status: string; detail: string }>
}

interface Service {
  id: number
  name: string
  type: string
}

// Which events a service type can produce — used to narrow the service list
// once an event is picked, so a rule can't be aimed at something that never fires.
const EVENTS: { key: Event; label: string; hint: string; types: string[] | null; state: boolean }[] = [
  { key: 'unreachable', label: 'Service unreachable', hint: "Can't connect, or the key/login is rejected.", types: null, state: true },
  { key: 'error', label: 'Service reports an error', hint: "The service's own health check says error.", types: null, state: true },
  { key: 'warning', label: 'Service reports a warning', hint: "The service's own health check says warning.", types: null, state: true },
  { key: 'stuck', label: 'Queue item stuck', hint: 'A Sonarr/Radarr download or import in warning or failed.', types: ['sonarr', 'radarr'], state: true },
  { key: 'download_failed', label: 'Download failed', hint: 'A failed download in NZBGet/SABnzbd.', types: ['nzbget', 'sabnzbd'], state: false },
  { key: 'request_issue', label: 'Request failed or issue reported', hint: 'A failed request or reported issue in Seerr.', types: ['seerr'], state: false },
  { key: 'stalled_approval', label: 'Request waiting for approval', hint: 'A Seerr request nobody has approved or declined yet.', types: ['seerr'], state: true },
  { key: 'stalled_sending', label: 'Request not in Sonarr/Radarr', hint: "Approved in Seerr but it hasn't reached Sonarr/Radarr.", types: ['seerr'], state: true },
  { key: 'stalled_searching', label: 'Request still searching', hint: 'In Sonarr/Radarr with nothing found to download yet.', types: ['seerr'], state: true },
  { key: 'stalled_downloading', label: 'Request still downloading', hint: 'Downloading for longer than this.', types: ['seerr'], state: true },
  { key: 'stalled_importing', label: 'Request stuck importing', hint: "Downloaded but not imported.", types: ['seerr'], state: true },
]
const EVENT_LABEL = Object.fromEntries(EVENTS.map((e) => [e.key, e.label])) as Record<Event, string>
const CHANNELS: { key: Channel; label: string }[] = [
  { key: 'email', label: 'Email' },
  { key: 'webhook', label: 'Webhook' },
  { key: 'ntfy', label: 'ntfy' },
  { key: 'sms', label: 'SMS' },
]

const EMPTY: Omit<Rule, 'id'> = {
  name: '',
  enabled: true,
  event: 'unreachable',
  service_id: null,
  threshold_minutes: 5,
  repeat_minutes: 0,
  channels: [],
  notify_resolved: true,
}

// SQLite datetimes are UTC without a zone marker.
function fmt(v: string) {
  const d = new Date(v.replace(' ', 'T') + 'Z')
  return Number.isNaN(d.getTime()) ? v : fmtDateTime(d)
}

function since(v: string) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(v.replace(' ', 'T') + 'Z').getTime()) / 60000))
  if (mins < 60) return `${mins}m`
  if (mins < 1440) return `${Math.floor(mins / 60)}h ${mins % 60}m`
  return `${Math.floor(mins / 1440)}d`
}

const SNOOZE_CHOICES: { label: string; minutes: number | null }[] = [
  { label: '1 hour', minutes: 60 },
  { label: '4 hours', minutes: 240 },
  { label: '1 day', minutes: 1440 },
  { label: '1 week', minutes: 10080 },
  { label: 'Until it clears', minutes: null },
]

// Snooze or acknowledge one problem — preset lengths, a custom number of
// hours, or "until it clears". The problem stays listed either way.
function SnoozeControl({ onSnooze }: { onSnooze: (minutes: number | null, note: string) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [hours, setHours] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function go(minutes: number | null) {
    setBusy(true)
    try {
      await onSnooze(minutes, note)
      setOpen(false)
      setNote('')
      setHours('')
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn-secondary shrink-0">
        Snooze
      </button>
    )
  }
  return (
    <div className="w-full mt-2 flex flex-wrap items-center gap-2">
      <input
        className="input sm:w-56"
        maxLength={500}
        placeholder="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      {SNOOZE_CHOICES.map((c) => (
        <button key={c.label} disabled={busy} onClick={() => go(c.minutes)} className="btn-secondary">
          {c.label}
        </button>
      ))}
      <input
        className="input w-24"
        type="number"
        min={1}
        placeholder="Hours"
        value={hours}
        onChange={(e) => setHours(e.target.value)}
      />
      <button
        disabled={busy || !(Number(hours) > 0)}
        onClick={() => go(Math.round(Number(hours) * 60))}
        className="btn-secondary"
      >
        Snooze for that
      </button>
      <button onClick={() => setOpen(false)} className="btn-secondary">
        Cancel
      </button>
    </div>
  )
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

export default function Alerts() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const canSnooze = user?.role === 'admin' || user?.role === 'analyst'
  const [rules, setRules] = useState<Rule[]>([])
  const [problems, setProblems] = useState<Problem[]>([])
  const [log, setLog] = useState<LogRow[]>([])
  const [services, setServices] = useState<Service[]>([])
  const [editing, setEditing] = useState<(Omit<Rule, 'id'> & { id?: number }) | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Rule | null>(null)
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState<Record<number, string>>({})
  const [openLog, setOpenLog] = useState<number | null>(null)
  const [fixing, setFixing] = useState<{ p: Problem; action: Problem['actions'][number] } | null>(null)
  const [fixBusy, setFixBusy] = useState<string>('')
  const [fixResult, setFixResult] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkSummary, setBulkSummary] = useState<{ ok: boolean; text: string } | null>(null)
  const [bulkConfirm, setBulkConfirm] = useState<Problem['actions'][number] | null>(null)
  // Set by clicking a "fix the same way" pill: shows only that group, until
  // toggled off or the group empties out (everything in it got fixed).
  const [groupFilter, setGroupFilter] = useState<string | null>(null)

  async function load() {
    const [r, p, l, s] = await Promise.all([
      api.get<Rule[]>('/alerts/rules'),
      api.get<Problem[]>('/alerts/active'),
      api.get<LogRow[]>('/alerts/log?limit=50'),
      api.get<Service[]>('/services/'),
    ])
    setRules(r)
    // A backend older than this page sends problems without advice/actions;
    // default them rather than let the page fall over.
    const loaded = p.map((x) => ({ ...x, advice: x.advice ?? '', actions: x.actions ?? [] }))
    setProblems(loaded)
    const still = new Set(loaded.map(rowKey))
    setSelected((sel) => new Set([...sel].filter((k) => still.has(k))))
    setGroupFilter((gf) => (gf && !loaded.some((x) => fixSet(x) === gf) ? null : gf))
    setLog(l)
    setServices(s)
  }

  useEffect(() => {
    load()
    const interval = setInterval(load, 20000)
    return () => clearInterval(interval)
  }, [])

  const serviceName = (id: number | null) =>
    id == null ? 'Every service' : services.find((s) => s.id === id)?.name ?? `Service ${id}`

  async function save() {
    if (!editing) return
    setSaving(true)
    setError('')
    try {
      const { id, ...body } = editing
      if (id) {
        await api.patch(`/alerts/rules/${id}`, {
          ...body,
          service_id: body.service_id ?? undefined,
          all_services: body.service_id == null,
        })
      } else {
        await api.post('/alerts/rules', { ...body, service_id: body.service_id ?? undefined })
      }
      setEditing(null)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save rule')
    } finally {
      setSaving(false)
    }
  }

  async function toggle(rule: Rule) {
    await api.patch(`/alerts/rules/${rule.id}`, { enabled: !rule.enabled })
    await load()
  }

  async function test(rule: Rule) {
    setTestResult((t) => ({ ...t, [rule.id]: 'Sending…' }))
    try {
      const res = await api.post<{ results: Record<string, { status: string; detail: string }> }>(
        `/alerts/rules/${rule.id}/test`,
        {},
      )
      const text = Object.entries(res.results)
        .map(([ch, r]) => `${ch}: ${resultText(r)}`)
        .join(' · ')
      setTestResult((t) => ({ ...t, [rule.id]: text || 'No channels' }))
      await load()
    } catch (err) {
      setTestResult((t) => ({ ...t, [rule.id]: err instanceof ApiError ? err.message : 'Test failed' }))
    }
  }

  async function remove() {
    if (!deleting) return
    setBusy(true)
    try {
      await api.delete(`/alerts/rules/${deleting.id}`)
      setDeleting(null)
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function snooze(p: Problem, minutes: number | null, note: string) {
    await api.post('/alerts/snooze', { service_id: p.service_id, key: p.key, minutes: minutes ?? undefined, note })
    await load()
  }

  async function runFix(p: Problem, action: string) {
    const rowKey = `${p.service_id}-${p.key}`
    setFixBusy(rowKey)
    try {
      const res = await api.post<{ ok?: boolean; files?: number; message?: string }>('/alerts/fix', {
        service_id: p.service_id,
        key: p.key,
        action,
      })
      const text =
        action === 'import'
          ? `Import started (${res.files} file${res.files === 1 ? '' : 's'}) — it clears at the next check once done.`
          : action === 'test_connection'
            ? `${res.ok ? '✓' : '✗'} ${res.message ?? ''}`
            : 'Done — it clears at the next check.'
      setFixResult((r) => ({ ...r, [rowKey]: { ok: res.ok !== false, text } }))
      await load()
    } catch (err) {
      setFixResult((r) => ({ ...r, [rowKey]: { ok: false, text: err instanceof ApiError ? err.message : 'Failed' } }))
    } finally {
      setFixBusy('')
    }
  }

  const visibleProblems = groupFilter ? problems.filter((p) => fixSet(p) === groupFilter) : problems
  const selectedProblems = problems.filter((p) => selected.has(rowKey(p)))
  const selectedFixSet = selectedProblems.length ? fixSet(selectedProblems[0]) : null
  const groups = Array.from(
    problems.reduce((m, p) => m.set(fixSet(p), [...(m.get(fixSet(p)) ?? []), p]), new Map<string, Problem[]>()),
  )

  function toggleSelected(p: Problem) {
    setSelected((sel) => {
      const next = new Set(sel)
      if (next.has(rowKey(p))) next.delete(rowKey(p))
      else next.add(rowKey(p))
      return next
    })
    setBulkSummary(null)
  }

  function selectGroup(set: string, list: Problem[]) {
    setBulkSummary(null)
    if (groupFilter === set) {
      // Same pill again: back to showing everything.
      setGroupFilter(null)
      setSelected(new Set())
      return
    }
    setGroupFilter(set)
    setSelected(new Set(list.map(rowKey)))
  }

  function summarise(results: { service_id: number; key: string; status: string; detail: string }[]) {
    const byStatus = (st: string) => results.filter((r) => r.status === st).length
    setFixResult((prev) => {
      const next = { ...prev }
      for (const r of results) {
        next[`${r.service_id}-${r.key}`] = {
          ok: r.status !== 'failed',
          text: r.status === 'ok' ? `Done${r.detail ? ` — ${r.detail}` : ''}` : `${r.status}: ${r.detail}`,
        }
      }
      return next
    })
    const failed = byStatus('failed')
    setBulkSummary({
      ok: failed === 0,
      text: `${byStatus('ok')} done${byStatus('skipped') ? `, ${byStatus('skipped')} skipped` : ''}${failed ? `, ${failed} failed` : ''}.`,
    })
  }

  async function runBulk(action: string) {
    setBulkBusy(true)
    setBulkSummary(null)
    try {
      const res = await api.post<{ results: { service_id: number; key: string; status: string; detail: string }[] }>(
        '/alerts/fix/bulk',
        { items: selectedProblems.map((p) => ({ service_id: p.service_id, key: p.key })), action },
      )
      summarise(res.results)
      setSelected(new Set())
      await load()
    } catch (err) {
      setBulkSummary({ ok: false, text: err instanceof ApiError ? err.message : 'Failed' })
    } finally {
      setBulkBusy(false)
    }
  }

  async function snoozeBulk(minutes: number | null, note: string) {
    const res = await api.post<{ results: { service_id: number; key: string; status: string; detail: string }[] }>(
      '/alerts/snooze/bulk',
      { items: selectedProblems.map((p) => ({ service_id: p.service_id, key: p.key })), minutes: minutes ?? undefined, note },
    )
    summarise(res.results)
    setSelected(new Set())
    await load()
  }

  async function unsnooze(p: Problem) {
    await api.delete(`/alerts/snooze?service_id=${p.service_id}&key=${encodeURIComponent(p.key)}`)
    await load()
  }

  const eventDef = EVENTS.find((e) => e.key === editing?.event)
  const eligibleServices = services.filter((s) => !eventDef?.types || eventDef.types.includes(s.type))

  return (
    <div>
      <h2 className="text-lg font-semibold text-slate-100 mb-4">Alerts</h2>

      <Section
        title={
          groupFilter
            ? `Current problems (${visibleProblems.length} of ${problems.length} shown)`
            : `Current problems (${problems.length})`
        }
      >
        {canSnooze && problems.length > 1 && (
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span>Select all that fix the same way:</span>
            {groups.map(([set, list]) => (
              <button
                key={set}
                onClick={() => selectGroup(set, list)}
                className={clsx('text-xs', groupFilter === set ? 'btn-secondary border-violet-600/60 text-violet-300' : 'btn-secondary')}
              >
                {list[0].actions.map((a) => a.label).join(' · ') || 'No fix — snooze only'} ({list.length})
              </button>
            ))}
            {groupFilter && (
              <button
                onClick={() => {
                  setGroupFilter(null)
                  setSelected(new Set())
                }}
                className="underline hover:text-slate-200"
              >
                Show all
              </button>
            )}
          </div>
        )}
        {selectedProblems.length > 0 && (
          <div className="mb-2 bg-slate-925 border border-violet-600/40 rounded-xl px-4 py-3 flex flex-wrap items-center gap-2">
            <span className="text-sm text-slate-100 font-medium mr-1">{selectedProblems.length} selected</span>
            {isAdmin &&
              selectedProblems[0].actions
                .filter((a) => a.id !== 'test_connection' || selectedProblems.length === 1)
                .map((a) => (
                  <button
                    key={a.id}
                    disabled={bulkBusy}
                    onClick={() => (a.destructive ? setBulkConfirm(a) : runBulk(a.id))}
                    className={
                      a.destructive
                        ? 'rounded-lg border border-red-900 text-red-300 hover:bg-red-950/50 text-sm px-3 py-1.5 disabled:opacity-50'
                        : 'rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-3 py-1.5'
                    }
                  >
                    {bulkBusy ? 'Working…' : `${a.label} (${selectedProblems.length})`}
                  </button>
                ))}
            <SnoozeControl onSnooze={snoozeBulk} />
            <button onClick={() => setSelected(new Set())} className="btn-secondary">
              Deselect
            </button>
          </div>
        )}
        {bulkSummary && (
          <p className={clsx('mb-2 text-sm', bulkSummary.ok ? 'text-teal-300' : 'text-red-300')}>{bulkSummary.text}</p>
        )}
        {problems.length === 0 ? (
          <p className="text-sm text-slate-400">Nothing wrong right now.</p>
        ) : visibleProblems.length === 0 ? (
          <p className="text-sm text-slate-400">Nothing left in this group — every one was fixed.</p>
        ) : (
          <div className="bg-slate-925 border border-slate-800 rounded-xl divide-y divide-slate-800">
            {visibleProblems.map((p) => (
              <div key={`${p.service_id}-${p.key}`} className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                {canSnooze && (
                  <input
                    type="checkbox"
                    className="accent-violet-500 shrink-0 disabled:opacity-40"
                    checked={selected.has(rowKey(p))}
                    disabled={selectedFixSet !== null && fixSet(p) !== selectedFixSet}
                    title={
                      selectedFixSet !== null && fixSet(p) !== selectedFixSet
                        ? 'Fixes differently from what is selected — resolve it separately'
                        : 'Select'
                    }
                    onChange={() => toggleSelected(p)}
                  />
                )}
                <Link
                  to={`/services/${p.service_id}`}
                  className="flex items-center gap-1.5 text-sm text-slate-200 hover:underline shrink-0"
                >
                  <ServiceIcon type={p.service_type} className="w-4 h-4 rounded-sm shrink-0" />
                  {p.service_name}
                </Link>
                <span
                  className={clsx(
                    'metadata-pill text-xs shrink-0 self-start sm:self-auto',
                    p.event === 'warning' ? 'text-amber-300' : 'text-red-300',
                  )}
                >
                  {EVENT_LABEL[p.event]}
                </span>
                <span className="text-sm text-slate-300 min-w-0 flex-1">
                  {p.title}
                  {p.detail && <span className="text-slate-400"> — {p.detail}</span>}
                </span>
                <span className="text-xs text-slate-400 shrink-0" title={fmt(p.first_seen)}>
                  for {since(p.first_seen)}
                </span>
                <div className="w-full sm:pl-1 space-y-2">
                  {p.advice && <p className="text-sm text-slate-200">{p.advice}</p>}
                  {(p.actions.length > 0 || appLink(p)) && (
                    <div className="flex flex-wrap items-center gap-2">
                      {isAdmin &&
                        p.actions.map((a) => (
                          <button
                            key={a.id}
                            disabled={fixBusy === `${p.service_id}-${p.key}`}
                            onClick={() => (a.destructive ? setFixing({ p, action: a }) : runFix(p, a.id))}
                            className={
                              a.destructive
                                ? 'rounded-lg border border-red-900 text-red-300 hover:bg-red-950/50 text-sm px-3 py-1.5 disabled:opacity-50'
                                : 'rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-3 py-1.5'
                            }
                          >
                            {fixBusy === `${p.service_id}-${p.key}` ? 'Working…' : a.label}
                          </button>
                        ))}
                      {appLink(p) && (
                        <a
                          href={appLink(p)!.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn-secondary"
                        >
                          {appLink(p)!.label}
                        </a>
                      )}
                    </div>
                  )}
                  {fixResult[`${p.service_id}-${p.key}`] && (
                    <p
                      className={clsx(
                        'text-xs',
                        fixResult[`${p.service_id}-${p.key}`].ok ? 'text-teal-300' : 'text-red-300',
                      )}
                    >
                      {fixResult[`${p.service_id}-${p.key}`].text}
                    </p>
                  )}
                </div>
                {p.snoozed ? (
                  <>
                    <span className="metadata-pill text-xs text-violet-300 shrink-0">
                      {p.snoozed_until ? `snoozed until ${fmt(p.snoozed_until)}` : 'acknowledged'}
                      {p.snoozed_by ? ` · ${p.snoozed_by}` : ''}
                    </span>
                    {canSnooze && (
                      <button onClick={() => unsnooze(p)} className="btn-secondary shrink-0">
                        Unsnooze
                      </button>
                    )}
                    {p.snooze_note && <span className="w-full text-xs text-slate-400">Note: {p.snooze_note}</span>}
                  </>
                ) : (
                  canSnooze && <SnoozeControl onSnooze={(m, n) => snooze(p, m, n)} />
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Rules"
        action={
          isAdmin &&
          !editing && (
            <button
              onClick={() => {
                setEditing({ ...EMPTY })
                setError('')
              }}
              className="rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium px-4 py-2"
            >
              New rule
            </button>
          )
        }
      >
        {editing && (
          <div className="bg-slate-925 border border-slate-800 rounded-xl p-4 mb-3 space-y-4">
            {error && (
              <div className="text-sm text-red-300 bg-red-950/50 border border-red-900 rounded-lg px-3 py-2">{error}</div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="block">
                <span className="block text-xs text-slate-400 mb-1">Name</span>
                <input
                  className="input"
                  maxLength={100}
                  placeholder="Sonarr down for 5 minutes"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              </label>
              <label className="block">
                <span className="block text-xs text-slate-400 mb-1">When</span>
                <select
                  className="input"
                  value={editing.event}
                  onChange={(e) => {
                    const event = e.target.value as Event
                    const def = EVENTS.find((x) => x.key === event)
                    const current = services.find((s) => s.id === editing.service_id)
                    const keep = !def?.types || (current && def.types.includes(current.type))
                    setEditing({ ...editing, event, service_id: keep ? editing.service_id : null })
                  }}
                >
                  {EVENTS.map((e) => (
                    <option key={e.key} value={e.key}>
                      {e.label}
                    </option>
                  ))}
                </select>
                <span className="block text-xs text-slate-400 mt-1">{eventDef?.hint}</span>
              </label>
              <label className="block">
                <span className="block text-xs text-slate-400 mb-1">On</span>
                <select
                  className="input"
                  value={editing.service_id ?? ''}
                  onChange={(e) => setEditing({ ...editing, service_id: e.target.value ? Number(e.target.value) : null })}
                >
                  <option value="">
                    {eventDef?.types ? `Every ${eventDef.types.join(' / ')} service` : 'Every service'}
                  </option>
                  {eligibleServices.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="block text-xs text-slate-400 mb-1">For at least (minutes)</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={10080}
                  value={editing.threshold_minutes}
                  onChange={(e) => setEditing({ ...editing, threshold_minutes: Number(e.target.value) })}
                />
                <span className="block text-xs text-slate-400 mt-1">
                  0 alerts on the first check that sees it. Checks run at each service's poll interval.
                </span>
              </label>
              {eventDef?.state && (
                <label className="block">
                  <span className="block text-xs text-slate-400 mb-1">Remind every (minutes)</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={10080}
                    value={editing.repeat_minutes}
                    onChange={(e) => setEditing({ ...editing, repeat_minutes: Number(e.target.value) })}
                  />
                  <span className="block text-xs text-slate-400 mt-1">
                    While it lasts. 0 alerts once. A snoozed problem doesn't remind.
                  </span>
                </label>
              )}
            </div>
            <div>
              <span className="block text-xs text-slate-400 mb-1">Send through</span>
              <div className="flex flex-wrap gap-4">
                {CHANNELS.map((c) => (
                  <label key={c.key} className="flex items-center gap-2 text-sm text-slate-200">
                    <input
                      type="checkbox"
                      className="accent-violet-500"
                      checked={editing.channels.includes(c.key)}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          channels: e.target.checked
                            ? [...editing.channels, c.key]
                            : editing.channels.filter((x) => x !== c.key),
                        })
                      }
                    />
                    {c.label}
                  </label>
                ))}
              </div>
              <span className="block text-xs text-slate-400 mt-1">
                Channels are set up under <Link to="/settings" className="underline hover:text-slate-200">Settings</Link>;
                users who turned a channel on for themselves get it too.
              </span>
            </div>
            <div className="flex flex-wrap gap-6">
              {eventDef?.state && (
                <label className="flex items-center gap-2 text-sm text-slate-200">
                  <input
                    type="checkbox"
                    className="accent-violet-500"
                    checked={editing.notify_resolved}
                    onChange={(e) => setEditing({ ...editing, notify_resolved: e.target.checked })}
                  />
                  Also send when it clears
                </label>
              )}
              <label className="flex items-center gap-2 text-sm text-slate-200">
                <input
                  type="checkbox"
                  className="accent-violet-500"
                  checked={editing.enabled}
                  onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
                />
                Enabled
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditing(null)} className="btn-secondary">
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving || !editing.name.trim() || editing.channels.length === 0}
                className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2"
              >
                {saving ? 'Saving…' : 'Save rule'}
              </button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {rules.map((r) => (
            <div key={r.id} className="bg-slate-925 border border-slate-800 rounded-xl p-4">
              <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 font-medium text-slate-100">
                    {r.name}
                    {!r.enabled && <span className="metadata-pill text-xs text-slate-400">off</span>}
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {EVENT_LABEL[r.event]} · {serviceName(r.service_id)} ·{' '}
                    {r.threshold_minutes ? `for ${r.threshold_minutes} min` : 'at once'}
                    {r.repeat_minutes ? ` · every ${r.repeat_minutes} min` : ''} · {r.channels.join(', ')}
                    {r.notify_resolved && EVENTS.find((e) => e.key === r.event)?.state ? ' · + resolved' : ''}
                  </div>
                </div>
                {isAdmin && (
                  <div className="flex gap-2 flex-wrap">
                    <button onClick={() => test(r)} className="btn-secondary">
                      Send test
                    </button>
                    <button onClick={() => toggle(r)} className="btn-secondary">
                      {r.enabled ? 'Turn off' : 'Turn on'}
                    </button>
                    <button
                      onClick={() => {
                        setEditing({ ...r })
                        setError('')
                      }}
                      className="btn-secondary"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => setDeleting(r)}
                      className="rounded-lg border border-red-900 text-red-300 hover:bg-red-950/50 text-sm px-3 py-1.5"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
              {testResult[r.id] && <p className="text-xs text-slate-300 mt-2">{testResult[r.id]}</p>}
            </div>
          ))}
          {rules.length === 0 && !editing && (
            <p className="text-sm text-slate-400">
              No rules yet — nothing is sent until you add one.{!isAdmin && ' Rules are set up by an admin.'}
            </p>
          )}
        </div>
      </Section>

      <Section title="Recently sent">
        {log.length === 0 ? (
          <p className="text-sm text-slate-400">Nothing sent yet.</p>
        ) : (
          <div className="bg-slate-925 border border-slate-800 rounded-xl divide-y divide-slate-800">
            {log.map((l) => {
              const failed = Object.values(l.results).some((r) => r.status === 'failed')
              return (
                <div key={l.id} className="px-4 py-2.5">
                  <button
                    onClick={() => setOpenLog(openLog === l.id ? null : l.id)}
                    className="w-full text-left flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3"
                  >
                    <span className="text-xs text-slate-400 shrink-0 sm:w-44">{fmt(l.sent_at)}</span>
                    <span
                      className={clsx(
                        'metadata-pill text-xs shrink-0 self-start sm:self-auto',
                        l.kind === 'resolved'
                          ? 'text-teal-300'
                          : l.kind === 'test'
                            ? 'text-violet-300'
                            : l.kind === 'digest'
                              ? 'text-slate-200'
                              : 'text-red-300',
                      )}
                    >
                      {l.kind}
                    </span>
                    <span className="text-sm text-slate-200 min-w-0 flex-1">{l.subject}</span>
                    <span className={clsx('text-xs shrink-0', failed ? 'text-red-300' : 'text-slate-400')}>
                      {Object.entries(l.results)
                        .map(([ch, r]) => `${ch} ${r.status}`)
                        .join(' · ') || 'no channels'}
                    </span>
                  </button>
                  {openLog === l.id && (
                    <div className="mt-2 space-y-1">
                      <pre className="whitespace-pre-wrap text-xs text-slate-300 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2">
                        {l.body}
                      </pre>
                      {Object.entries(l.results).map(([ch, r]) => (
                        <p key={ch} className="text-xs text-slate-400">
                          {ch}: {resultText(r)}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Section>

      {bulkConfirm && (
        <ConfirmDeleteModal
          title={`${bulkConfirm.label}: ${selectedProblems.length} items?`}
          warning={
            bulkConfirm.id === 'redownload'
              ? 'Each download is removed from the queue and the download client, and its release is blocklisted; a search for another release starts for each.'
              : bulkConfirm.id === 'clear_request'
                ? 'Each request is deleted from Seerr outright. If anyone wants it again, they have to ask again.'
                : 'Each download is removed from the queue and the download client.'
          }
          confirmLabel={`${bulkConfirm.label} (${selectedProblems.length})`}
          busy={bulkBusy}
          onConfirm={async () => {
            const a = bulkConfirm
            setBulkConfirm(null)
            await runBulk(a.id)
          }}
          onCancel={() => setBulkConfirm(null)}
        />
      )}

      {fixing && (
        <ConfirmDeleteModal
          title={`${fixing.action.label}: ${fixing.p.title}?`}
          warning={
            fixing.action.id === 'redownload'
              ? 'The download is removed from the queue and the download client, and the release is blocklisted; a search for another release starts.'
              : fixing.action.id === 'clear_request'
                ? 'The request is deleted from Seerr outright. If anyone wants it again, they have to ask again.'
                : 'The download is removed from the queue and the download client.'
          }
          confirmLabel={fixing.action.label}
          busy={!!fixBusy}
          onConfirm={async () => {
            const { p, action } = fixing
            setFixing(null)
            await runFix(p, action.id)
          }}
          onCancel={() => setFixing(null)}
        />
      )}

      {deleting && (
        <ConfirmDeleteModal
          title={`Delete rule “${deleting.name}”?`}
          warning="Nothing will be sent for this rule any more."
          busy={busy}
          onConfirm={remove}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  )
}
