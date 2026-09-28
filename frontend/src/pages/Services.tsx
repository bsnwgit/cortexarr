import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import ServiceIcon from '../components/ServiceIcon'
import StatusPill, { type StatusInfo } from '../components/StatusPill'
import { getServiceAccent } from '../utils/serviceAccent'
import { copyToClipboard } from '../utils/clipboard'

interface Service {
  id: number
  name: string
  type: string
  base_url: string
  api_key: string
  enabled: boolean
  maintenance_mode: boolean
  ingestion_mode: string
  poll_interval_seconds: number
  retry_count: number
  retry_backoff_seconds: number
}

// Sonarr/Radarr only — the other types have no webhook connection to push
// events from.
const WEBHOOK_TYPES = new Set(['sonarr', 'radarr'])

const EMPTY_FORM = {
  name: '',
  type: 'sonarr',
  base_url: '',
  api_key: '',
  poll_interval_seconds: 60,
  retry_count: 3,
  retry_backoff_seconds: 5,
  ingestion_mode: 'poll',
}

export default function Services() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [services, setServices] = useState<Service[]>([])
  // The add form is opened from the user menu's "Add service" (?add=1), so
  // it's driven by the URL rather than a button on this page.
  const [searchParams, setSearchParams] = useSearchParams()
  const showForm = searchParams.get('add') === '1'
  const setShowForm = (open: boolean) => setSearchParams(open ? { add: '1' } : {})
  const [form, setForm] = useState(EMPTY_FORM)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [rowBusy, setRowBusy] = useState<Record<number, string>>({})
  const [rowTestResult, setRowTestResult] = useState<Record<number, { ok: boolean; message: string }>>({})
  const [statusById, setStatusById] = useState<Record<number, StatusInfo>>({})
  const [webhookOpen, setWebhookOpen] = useState<number | null>(null)
  const [webhookInfo, setWebhookInfo] = useState<Record<number, { ingestion_mode: string; path: string }>>({})
  const [webhookBusy, setWebhookBusy] = useState<number | null>(null)
  const [webhookCopied, setWebhookCopied] = useState(false)
  // NZBGet has no API key — it logs in with its own username/password,
  // sent (and stored encrypted) as "username:password" in the key field.
  const [nzbUser, setNzbUser] = useState('')
  const [nzbPass, setNzbPass] = useState('')
  const credential = form.type === 'nzbget' ? (nzbUser || nzbPass ? `${nzbUser}:${nzbPass}` : '') : form.api_key

  async function load() {
    setServices(await api.get<Service[]>('/services/'))
  }

  async function loadStatus() {
    const data = await api.get<{ services: (StatusInfo & { id: number })[] }>('/status/')
    setStatusById(Object.fromEntries(data.services.map((s) => [s.id, s])))
  }

  useEffect(() => {
    load()
    loadStatus()
    const interval = setInterval(loadStatus, 15000)
    return () => clearInterval(interval)
  }, [])

  async function testUnsaved() {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await api.post<{ ok: boolean; message: string }>('/services/test-connection', {
        type: form.type,
        base_url: form.base_url,
        api_key: credential,
      })
      setTestResult(result)
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof ApiError ? err.message : 'Test failed' })
    } finally {
      setTesting(false)
    }
  }

  async function testSaved(id: number) {
    setRowBusy((b) => ({ ...b, [id]: 'testing' }))
    setRowTestResult((r) => ({ ...r, [id]: undefined as any }))
    try {
      const result = await api.post<{ ok: boolean; message: string }>(`/services/${id}/test-connection`)
      setRowTestResult((r) => ({ ...r, [id]: result }))
    } catch (err) {
      setRowTestResult((r) => ({ ...r, [id]: { ok: false, message: err instanceof ApiError ? err.message : 'Test failed' } }))
    } finally {
      setRowBusy((b) => ({ ...b, [id]: '' }))
    }
  }

  async function toggleMaintenance(s: Service) {
    setRowBusy((b) => ({ ...b, [s.id]: 'saving' }))
    await api.patch(`/services/${s.id}`, { maintenance_mode: !s.maintenance_mode })
    await Promise.all([load(), loadStatus()])
    setRowBusy((b) => ({ ...b, [s.id]: '' }))
  }

  async function openWebhook(s: Service) {
    if (webhookOpen === s.id) {
      setWebhookOpen(null)
      return
    }
    setWebhookOpen(s.id)
    setWebhookCopied(false)
    if (!webhookInfo[s.id]) {
      const info = await api.get<{ ingestion_mode: string; path: string }>(`/services/${s.id}/webhook`)
      setWebhookInfo((w) => ({ ...w, [s.id]: info }))
    }
  }

  async function toggleWebhookMode(s: Service) {
    setWebhookBusy(s.id)
    try {
      const next = s.ingestion_mode === 'webhook' ? 'poll' : 'webhook'
      await api.patch(`/services/${s.id}`, { ingestion_mode: next })
      if (next === 'webhook' && !webhookInfo[s.id]) {
        const info = await api.get<{ ingestion_mode: string; path: string }>(`/services/${s.id}/webhook`)
        setWebhookInfo((w) => ({ ...w, [s.id]: info }))
      }
      await load()
    } finally {
      setWebhookBusy(null)
    }
  }

  async function regenerateWebhookToken(s: Service) {
    if (!confirm('The current webhook URL will stop working the moment the new one is issued. Continue?')) return
    setWebhookBusy(s.id)
    try {
      const info = await api.post<{ ingestion_mode: string; path: string }>(`/services/${s.id}/webhook/regenerate`, {})
      setWebhookInfo((w) => ({ ...w, [s.id]: info }))
    } finally {
      setWebhookBusy(null)
    }
  }

  async function copyWebhookUrl(path: string) {
    const ok = await copyToClipboard(`${window.location.origin}${path}`)
    setWebhookCopied(ok)
    setTimeout(() => setWebhookCopied(false), 1500)
  }

  async function remove(s: Service) {
    if (!confirm(`Delete "${s.name}"? This can't be undone.`)) return
    await api.delete(`/services/${s.id}`)
    await load()
  }

  async function submit() {
    setError('')
    setSaving(true)
    try {
      await api.post('/services/', { ...form, api_key: credential })
      setShowForm(false)
      setForm(EMPTY_FORM)
      setNzbUser('')
      setNzbPass('')
      setTestResult(null)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-slate-100">{showForm ? 'Add a service' : 'Monitored services'}</h2>
        {isAdmin && !showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium px-4 py-2"
          >
            New service
          </button>
        )}
      </div>

      {showForm && (
        <div className="bg-slate-925 border border-slate-800 rounded-xl p-4 mb-4 space-y-3">
          {error && <div className="text-sm text-red-300 bg-red-950/50 border border-red-900 rounded-lg px-3 py-2">{error}</div>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Name">
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Type">
              <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="sonarr">Sonarr</option>
                <option value="radarr">Radarr</option>
                <option value="seerr">Seerr</option>
                <option value="nzbget">NZBGet</option>
                <option value="sabnzbd">SABnzbd</option>
              </select>
            </Field>
            <Field label="Base URL">
              <input className="input" placeholder={`http://192.168.1.50:${({ radarr: 7878, seerr: 5055, nzbget: 6789, sabnzbd: 8080 } as Record<string, number>)[form.type] ?? 8989}`} value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} />
            </Field>
            {form.type === 'nzbget' ? (
              <>
                <Field label="Username">
                  <input className="input" autoComplete="off" value={nzbUser} onChange={(e) => setNzbUser(e.target.value)} />
                </Field>
                <Field label="Password">
                  <input className="input" type="password" autoComplete="new-password" value={nzbPass} onChange={(e) => setNzbPass(e.target.value)} />
                </Field>
              </>
            ) : (
              <Field label="API key">
                <input className="input" type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} />
              </Field>
            )}
            <Field label="Poll interval (seconds)">
              <input className="input" type="number" min={10} value={form.poll_interval_seconds} onChange={(e) => setForm({ ...form, poll_interval_seconds: Number(e.target.value) })} />
            </Field>
            <Field label="Retries / backoff (seconds)">
              <div className="flex gap-2">
                <input className="input" type="number" min={0} value={form.retry_count} onChange={(e) => setForm({ ...form, retry_count: Number(e.target.value) })} />
                <input className="input" type="number" min={1} value={form.retry_backoff_seconds} onChange={(e) => setForm({ ...form, retry_backoff_seconds: Number(e.target.value) })} />
              </div>
            </Field>
          </div>

          {WEBHOOK_TYPES.has(form.type) && (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5 accent-violet-500"
                checked={form.ingestion_mode === 'webhook'}
                onChange={(e) => setForm({ ...form, ingestion_mode: e.target.checked ? 'webhook' : 'poll' })}
              />
              <span className="text-sm text-slate-300">
                Also accept webhooks from {form.type === 'sonarr' ? 'Sonarr' : 'Radarr'}
                <span className="block text-xs text-slate-400">
                  Reacts to a health change the moment it happens instead of waiting for the next poll. Doesn't
                  replace polling — the webhook URL to paste into {form.type === 'sonarr' ? 'Sonarr' : 'Radarr'} shows
                  up here once the service is saved.
                </span>
              </span>
            </label>
          )}

          <div className="flex items-center gap-3">
            <button onClick={testUnsaved} disabled={testing || !form.base_url || !credential} className="btn-secondary">
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            {testResult && (
              <span className={testResult.ok ? 'text-teal-300 text-sm' : 'text-red-300 text-sm'}>{testResult.message}</span>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setShowForm(false)} className="btn-secondary">
              Cancel
            </button>
            <button onClick={submit} disabled={saving || !form.name || !form.base_url} className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2">
              {saving ? 'Saving…' : 'Save service'}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {services.map((s) => (
          <div
            key={s.id}
            onClick={() => navigate(`/services/${s.id}`)}
            role="link"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter') navigate(`/services/${s.id}`)
            }}
            className="cursor-pointer bg-slate-925 border border-slate-800 rounded-xl p-4 hover:border-violet-600/40 transition-colors"
          >
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
              <div>
                <div className="flex items-center gap-2 font-medium text-slate-100">
                  <ServiceIcon type={s.type} className="w-5 h-5 rounded-sm shrink-0" />
                  {s.name}
                  <StatusPill
                    service={statusById[s.id] ?? { maintenance_mode: s.maintenance_mode, status: null }}
                    accent={getServiceAccent(s.type)}
                    serviceId={s.id}
                  />
                </div>
                <div className="text-xs text-slate-500">
                  {s.type} ·{' '}
                  <a
                    href={s.base_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="hover:text-slate-300 hover:underline"
                  >
                    {s.base_url}
                  </a>{' '}
                  · every {s.poll_interval_seconds}s
                  {s.ingestion_mode === 'webhook' && ' · webhooks on'}
                </div>
              </div>
              <div className="flex gap-2 flex-wrap" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => testSaved(s.id)} disabled={rowBusy[s.id] === 'testing'} className="btn-secondary">
                  {rowBusy[s.id] === 'testing' ? 'Testing…' : 'Test'}
                </button>
                {WEBHOOK_TYPES.has(s.type) && (
                  <button onClick={() => openWebhook(s)} className="btn-secondary">
                    Webhook
                  </button>
                )}
                <button onClick={() => toggleMaintenance(s)} className="btn-secondary">
                  {s.maintenance_mode ? 'End maintenance' : 'Maintenance mode'}
                </button>
                <button onClick={() => remove(s)} className="rounded-lg border border-red-900 text-red-300 hover:bg-red-950/50 text-sm px-3 py-1.5">
                  Delete
                </button>
              </div>
            </div>
            {webhookOpen === s.id && (
              <div className="mt-3 bg-slate-950 border border-slate-800 rounded-lg p-3 space-y-2" onClick={(e) => e.stopPropagation()}>
                {s.ingestion_mode === 'webhook' ? (
                  webhookInfo[s.id] ? (
                    <>
                      <p className="text-xs text-slate-400">
                        Paste this into {s.type === 'sonarr' ? 'Sonarr' : 'Radarr'} → Settings → Connect → add a
                        Webhook, method <code className="text-slate-300">POST</code>, with{' '}
                        <span className="text-slate-300">Health Issue</span>,{' '}
                        <span className="text-slate-300">Health Restored</span>, and the on-add{' '}
                        <span className="text-slate-300">Test</span> ticked.
                      </p>
                      <div className="flex gap-2 items-center">
                        <code className="flex-1 min-w-0 break-all select-all rounded-lg bg-slate-925 border border-slate-800 px-3 py-2 text-xs text-slate-100">
                          {window.location.origin}{webhookInfo[s.id].path}
                        </code>
                        <button onClick={() => copyWebhookUrl(webhookInfo[s.id].path)} className="btn-secondary shrink-0">
                          {webhookCopied ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                      <div className="flex gap-2 flex-wrap pt-1">
                        <button onClick={() => regenerateWebhookToken(s)} disabled={webhookBusy === s.id} className="btn-secondary">
                          {webhookBusy === s.id ? 'Working…' : 'Regenerate URL'}
                        </button>
                        <button onClick={() => toggleWebhookMode(s)} disabled={webhookBusy === s.id} className="btn-secondary">
                          Turn off webhooks
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="text-xs text-slate-400">Loading…</p>
                  )
                ) : (
                  <>
                    <p className="text-xs text-slate-400">
                      Webhooks are off — Cortexarr only polls this service, every {s.poll_interval_seconds}s.
                    </p>
                    <button onClick={() => toggleWebhookMode(s)} disabled={webhookBusy === s.id} className="btn-secondary">
                      {webhookBusy === s.id ? 'Working…' : 'Turn on webhooks'}
                    </button>
                  </>
                )}
              </div>
            )}
            {rowTestResult[s.id] && (
              <p className={clsx('text-xs mt-2', rowTestResult[s.id].ok ? 'text-teal-300' : 'text-red-300')}>
                {rowTestResult[s.id].ok ? '✓ ' : '✗ '}{rowTestResult[s.id].message}
              </p>
            )}
          </div>
        ))}
        {services.length === 0 && !showForm && <p className="text-slate-500 text-sm">No services yet.</p>}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm text-slate-400 mb-1">{label}</span>
      {children}
    </label>
  )
}
