import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import ConfirmDeleteModal from '../components/ConfirmDeleteModal'
import { PageControls, PageSizeSelect } from '../components/Pagination'
import { resultText } from '../utils/notifyResult'
import { EVENTS, EVENT_LABEL, type Event } from '../utils/alertEvents'

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

interface Service {
  id: number
  name: string
  type: string
}

const CHANNELS: { key: Channel; label: string }[] = [
  { key: 'email', label: 'Email' },
  { key: 'webhook', label: 'Webhook' },
  { key: 'ntfy', label: 'ntfy' },
  { key: 'sms', label: 'SMS' },
]

// Suggested starter rules (README "Suggested alert rules"): offered below
// the rule list only while it's empty, so it's obvious what's worth
// alerting on instead of finding out nothing fires until you add one.
// "Request stalled" has no single event of its own — it's one rule per
// stage, all added together.
const STAGE_LABEL: Partial<Record<Event, string>> = {
  stalled_approval: 'awaiting approval',
  stalled_sending: 'not yet sent to Sonarr/Radarr',
  stalled_searching: 'searching',
  stalled_downloading: 'downloading',
  stalled_importing: 'importing',
}
interface Template {
  key: string
  title: string
  hint: string
  rules: Array<Omit<Rule, 'id' | 'channels'>>
}
const TEMPLATES: Template[] = [
  {
    key: 'unreachable',
    title: 'Service unreachable',
    hint: "Alert when any service can't be reached, or its API key is rejected, for 5 minutes straight.",
    rules: [
      { name: 'Service unreachable', enabled: true, event: 'unreachable', service_id: null, threshold_minutes: 5, repeat_minutes: 0, notify_resolved: true },
    ],
  },
  {
    key: 'stuck',
    title: 'Queue item stuck',
    hint: 'Alert when a Sonarr/Radarr download or import sits in warning or failed for 30 minutes.',
    rules: [
      { name: 'Queue item stuck', enabled: true, event: 'stuck', service_id: null, threshold_minutes: 30, repeat_minutes: 0, notify_resolved: true },
    ],
  },
  {
    key: 'stalled',
    title: 'Request stalled',
    hint: 'Alert when a Seerr request sits a full day in one stage — awaiting approval, not yet sent, searching, downloading, or importing.',
    rules: (Object.keys(STAGE_LABEL) as Event[]).map((event) => ({
      name: `Request stalled — ${STAGE_LABEL[event]}`,
      enabled: true,
      event,
      service_id: null,
      threshold_minutes: 1440,
      repeat_minutes: 0,
      notify_resolved: true,
    })),
  },
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

// Your own rules for what notifies — split out from the current-problems/
// recently-sent view (Alerts.tsx) so managing rules doesn't compete for
// space with what's actively wrong right now.
export default function Rules() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [rules, setRules] = useState<Rule[]>([])
  const [services, setServices] = useState<Service[]>([])
  const [editing, setEditing] = useState<(Omit<Rule, 'id'> & { id?: number }) | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Rule | null>(null)
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState<Record<number, string>>({})
  const [channelsEnabled, setChannelsEnabled] = useState<Channel[]>([])
  const [addingTemplate, setAddingTemplate] = useState<string | null>(null)
  const [templateError, setTemplateError] = useState('')
  const [pageSize, setPageSize] = useState(10)
  const [page, setPage] = useState(1)

  async function load() {
    const [r, s, st] = await Promise.all([
      api.get<Rule[]>('/alerts/rules'),
      api.get<Service[]>('/services/'),
      api.get<Record<string, unknown>>('/settings/'),
    ])
    setRules(r)
    setServices(s)
    setChannelsEnabled((['email', 'webhook', 'ntfy', 'sms'] as Channel[]).filter((c) => !!st[`notify_${c}_enabled`]))
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

  async function addTemplate(t: Template) {
    if (channelsEnabled.length === 0) return
    setAddingTemplate(t.key)
    setTemplateError('')
    try {
      for (const rule of t.rules) {
        await api.post('/alerts/rules', { ...rule, channels: channelsEnabled, service_id: rule.service_id ?? undefined })
      }
      await load()
    } catch (err) {
      setTemplateError(err instanceof ApiError ? err.message : 'Failed to add rule')
    } finally {
      setAddingTemplate(null)
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

  const eventDef = EVENTS.find((e) => e.key === editing?.event)
  const eligibleServices = services.filter((s) => !eventDef?.types || eventDef.types.includes(s.type))

  const totalPages = Math.max(1, Math.ceil(rules.length / pageSize))
  const page_ = Math.min(page, totalPages)
  const pageRules = useMemo(() => rules.slice((page_ - 1) * pageSize, page_ * pageSize), [rules, page_, pageSize])

  return (
    <div>
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-slate-200">Rules {rules.length > 0 && `(${rules.length})`}</h3>
        {isAdmin && !editing && (
          <button
            onClick={() => {
              setEditing({ ...EMPTY })
              setError('')
            }}
            className="rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium px-4 py-2"
          >
            New rule
          </button>
        )}
      </div>

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

      {rules.length > 0 && (
        <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
          <PageSizeSelect
            value={pageSize}
            onChange={(n) => {
              setPageSize(n)
              setPage(1)
            }}
          />
          {totalPages > 1 && <PageControls page={page_} totalPages={totalPages} onChange={setPage} />}
        </div>
      )}

      <div className="space-y-2">
        {pageRules.map((r) => (
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
        {rules.length === 0 && !editing && !isAdmin && (
          <p className="text-sm text-slate-400">
            No rules yet — nothing is sent until you add one. Rules are set up by an admin.
          </p>
        )}
        {rules.length === 0 && !editing && isAdmin && (
          <div className="space-y-3">
            <p className="text-sm text-slate-400">
              No rules yet — nothing is sent until you add one.{' '}
              {channelsEnabled.length === 0 ? (
                <>
                  Turn on a notification channel under{' '}
                  <Link to="/settings" className="underline hover:text-slate-200">Settings</Link> to use a
                  suggestion below, or add your own.
                </>
              ) : (
                'Start from a suggestion, or add your own.'
              )}
            </p>
            {templateError && <p className="text-sm text-red-300">{templateError}</p>}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {TEMPLATES.map((t) => (
                <div key={t.key} className="bg-slate-925 border border-slate-800 rounded-xl p-4 flex flex-col gap-2">
                  <div className="font-medium text-slate-100 text-sm">{t.title}</div>
                  <p className="text-xs text-slate-400 flex-1">{t.hint}</p>
                  <button
                    onClick={() => addTemplate(t)}
                    disabled={!!addingTemplate || channelsEnabled.length === 0}
                    className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-3 py-1.5 self-start"
                  >
                    {addingTemplate === t.key ? 'Adding…' : 'Add'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {deleting && (
        <ConfirmDeleteModal
          title={`Delete rule "${deleting.name}"?`}
          warning="Nothing will be sent for this rule any more."
          busy={busy}
          onConfirm={remove}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  )
}
