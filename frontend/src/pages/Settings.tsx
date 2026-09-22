import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../api/client'

type Settings = Record<string, any>

const MASK = '••••••••'

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testStatus, setTestStatus] = useState<Record<string, string>>({})

  async function load() {
    setSettings(await api.get<Settings>('/settings/'))
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  function set(key: string, value: unknown) {
    setSettings((s) => ({ ...s, [key]: value }))
  }

  async function save() {
    setSaving(true)
    try {
      await api.post('/settings/bulk', settings)
    } finally {
      setSaving(false)
    }
  }

  async function test(channel: string) {
    setTestStatus((s) => ({ ...s, [channel]: 'testing' }))
    const result = await api.post<{ status: string; detail: string }>('/settings/test-notification', { channel })
    setTestStatus((s) => ({ ...s, [channel]: `${result.status}: ${result.detail}` }))
  }

  if (loading) return <p className="text-slate-500 text-sm">Loading…</p>

  return (
    <div className="space-y-6 max-w-3xl">
      <h2 className="text-lg font-semibold text-slate-100">Notifications &amp; settings</h2>

      <Section title="Email" enabled={settings.notify_email_enabled} onToggle={(v) => set('notify_email_enabled', v)} onTest={() => test('email')} testStatus={testStatus.email}>
        <Row label="SMTP host"><input className="input" value={settings.notify_email_smtp_host || ''} onChange={(e) => set('notify_email_smtp_host', e.target.value)} /></Row>
        <Row label="SMTP port"><input className="input" type="number" value={settings.notify_email_smtp_port || 587} onChange={(e) => set('notify_email_smtp_port', Number(e.target.value))} /></Row>
        <Row label="Username"><input className="input" value={settings.notify_email_username || ''} onChange={(e) => set('notify_email_username', e.target.value)} /></Row>
        <Row label="Password">
          <input className="input" type="password" placeholder={settings.notify_email_password === MASK ? 'unchanged' : ''}
            value={settings.notify_email_password === MASK ? '' : (settings.notify_email_password || '')}
            onChange={(e) => set('notify_email_password', e.target.value)} />
        </Row>
        <Row label="From address"><input className="input" value={settings.notify_email_from || ''} onChange={(e) => set('notify_email_from', e.target.value)} /></Row>
        <Row label="Send to (comma-separated)">
          <input className="input" value={(settings.notify_email_default_to || []).join(', ')}
            onChange={(e) => set('notify_email_default_to', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
        </Row>
      </Section>

      <Section title="Webhook (Slack / Discord)" enabled={settings.notify_webhook_enabled} onToggle={(v) => set('notify_webhook_enabled', v)} onTest={() => test('webhook')} testStatus={testStatus.webhook}>
        <Row label="Webhook URL"><input className="input" value={settings.notify_webhook_url || ''} onChange={(e) => set('notify_webhook_url', e.target.value)} /></Row>
      </Section>

      <Section title="Push (ntfy)" enabled={settings.notify_ntfy_enabled} onToggle={(v) => set('notify_ntfy_enabled', v)} onTest={() => test('ntfy')} testStatus={testStatus.ntfy}>
        <Row label="Server"><input className="input" value={settings.notify_ntfy_server || ''} onChange={(e) => set('notify_ntfy_server', e.target.value)} /></Row>
        <Row label="Topic"><input className="input" value={settings.notify_ntfy_topic || ''} onChange={(e) => set('notify_ntfy_topic', e.target.value)} /></Row>
        <Row label="Auth token (optional)">
          <input className="input" type="password" placeholder={settings.notify_ntfy_auth_token === MASK ? 'unchanged' : ''}
            value={settings.notify_ntfy_auth_token === MASK ? '' : (settings.notify_ntfy_auth_token || '')}
            onChange={(e) => set('notify_ntfy_auth_token', e.target.value)} />
        </Row>
      </Section>

      <Section title="SMS (Twilio)" enabled={settings.notify_sms_enabled} onToggle={(v) => set('notify_sms_enabled', v)} onTest={() => test('sms')} testStatus={testStatus.sms}>
        <Row label="Account SID"><input className="input" value={settings.notify_sms_twilio_account_sid || ''} onChange={(e) => set('notify_sms_twilio_account_sid', e.target.value)} /></Row>
        <Row label="Auth token">
          <input className="input" type="password" placeholder={settings.notify_sms_twilio_auth_token === MASK ? 'unchanged' : ''}
            value={settings.notify_sms_twilio_auth_token === MASK ? '' : (settings.notify_sms_twilio_auth_token || '')}
            onChange={(e) => set('notify_sms_twilio_auth_token', e.target.value)} />
        </Row>
        <Row label="From number"><input className="input" value={settings.notify_sms_twilio_from_number || ''} onChange={(e) => set('notify_sms_twilio_from_number', e.target.value)} /></Row>
        <Row label="Send to (comma-separated)">
          <input className="input" value={(settings.notify_sms_default_to || []).join(', ')}
            onChange={(e) => set('notify_sms_default_to', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
        </Row>
      </Section>

      <div className="bg-slate-925 border border-slate-800 rounded-xl p-4 space-y-3">
        <h3 className="font-medium text-slate-100">General</h3>
        <Row label="Notification batching window (minutes, 0 = immediate)">
          <input className="input" type="number" min={0} value={settings.notify_batch_window_minutes ?? 0} onChange={(e) => set('notify_batch_window_minutes', Number(e.target.value))} />
        </Row>
        <Row label="Health-check history retention (days)">
          <input className="input" type="number" min={1} value={settings.health_retention_days ?? 30} onChange={(e) => set('health_retention_days', Number(e.target.value))} />
        </Row>
        <Row label="Self-update mode">
          <select className="input" value={settings.self_update_mode || 'manual'} onChange={(e) => set('self_update_mode', e.target.value)}>
            <option value="manual">Manual (notify only)</option>
            <option value="auto">Auto (apply during window below)</option>
          </select>
        </Row>
        {settings.self_update_mode === 'auto' && (
          <Row label="Update window">
            <div className="flex gap-2 items-center">
              <input className="input" type="time" value={settings.self_update_window_start || '02:00'} onChange={(e) => set('self_update_window_start', e.target.value)} />
              <span className="text-slate-500">to</span>
              <input className="input" type="time" value={settings.self_update_window_end || '04:00'} onChange={(e) => set('self_update_window_end', e.target.value)} />
            </div>
          </Row>
        )}
      </div>

      <button onClick={save} disabled={saving} className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2">
        {saving ? 'Saving…' : 'Save settings'}
      </button>
    </div>
  )
}

function Section({ title, enabled, onToggle, onTest, testStatus, children }: {
  title: string; enabled: boolean; onToggle: (v: boolean) => void; onTest: () => void; testStatus?: string; children: ReactNode
}) {
  return (
    <div className="bg-slate-925 border border-slate-800 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 font-medium text-slate-100">
          <input type="checkbox" checked={!!enabled} onChange={(e) => onToggle(e.target.checked)} className="accent-violet-500" />
          {title}
        </label>
        <button onClick={onTest} disabled={!enabled} className="btn-secondary">Send test</button>
      </div>
      {enabled && <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>}
      {testStatus && <p className="text-xs text-slate-400">{testStatus}</p>}
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm text-slate-400 mb-1">{label}</span>
      {children}
    </label>
  )
}
