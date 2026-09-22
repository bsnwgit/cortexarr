import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'

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

const EMPTY_FORM = {
  name: '',
  type: 'sonarr',
  base_url: '',
  api_key: '',
  poll_interval_seconds: 60,
  retry_count: 3,
  retry_backoff_seconds: 5,
}

export default function Services() {
  const [services, setServices] = useState<Service[]>([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [rowBusy, setRowBusy] = useState<Record<number, string>>({})
  const [rowTestResult, setRowTestResult] = useState<Record<number, { ok: boolean; message: string }>>({})

  async function load() {
    setServices(await api.get<Service[]>('/services/'))
  }

  useEffect(() => {
    load()
  }, [])

  async function testUnsaved() {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await api.post<{ ok: boolean; message: string }>('/services/test-connection', {
        type: form.type,
        base_url: form.base_url,
        api_key: form.api_key,
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
    await load()
    setRowBusy((b) => ({ ...b, [s.id]: '' }))
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
      await api.post('/services/', form)
      setShowForm(false)
      setForm(EMPTY_FORM)
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
        <h2 className="text-lg font-semibold text-slate-100">Monitored services</h2>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium px-3 py-1.5"
        >
          {showForm ? 'Cancel' : '+ Add service'}
        </button>
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
                <option value="radarr" disabled>Radarr (coming soon)</option>
                <option value="seerr" disabled>Seerr (coming soon)</option>
                <option value="nzbget" disabled>NZBGet (coming soon)</option>
                <option value="sabnzbd" disabled>SABnzbd (coming soon)</option>
              </select>
            </Field>
            <Field label="Base URL">
              <input className="input" placeholder="http://192.168.1.50:8989" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} />
            </Field>
            <Field label="API key">
              <input className="input" type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} />
            </Field>
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

          <div className="flex items-center gap-3">
            <button onClick={testUnsaved} disabled={testing || !form.base_url || !form.api_key} className="btn-secondary">
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            {testResult && (
              <span className={testResult.ok ? 'text-teal-300 text-sm' : 'text-red-300 text-sm'}>{testResult.message}</span>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={submit} disabled={saving || !form.name || !form.base_url} className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2">
              {saving ? 'Saving…' : 'Save service'}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {services.map((s) => (
          <div key={s.id} className="bg-slate-925 border border-slate-800 rounded-xl p-4">
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
              <div>
                <div className="font-medium text-slate-100">{s.name}</div>
                <div className="text-xs text-slate-500">
                  {s.type} · {s.base_url} · every {s.poll_interval_seconds}s
                  {s.maintenance_mode && <span className="text-amber-400"> · maintenance</span>}
                </div>
              </div>
              <div className="flex gap-2 flex-wrap">
                <button onClick={() => testSaved(s.id)} disabled={rowBusy[s.id] === 'testing'} className="btn-secondary">
                  {rowBusy[s.id] === 'testing' ? 'Testing…' : 'Test'}
                </button>
                <button onClick={() => toggleMaintenance(s)} className="btn-secondary">
                  {s.maintenance_mode ? 'End maintenance' : 'Maintenance mode'}
                </button>
                <button onClick={() => remove(s)} className="rounded-lg border border-red-900 text-red-300 hover:bg-red-950/50 text-sm px-3 py-1.5">
                  Delete
                </button>
              </div>
            </div>
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
