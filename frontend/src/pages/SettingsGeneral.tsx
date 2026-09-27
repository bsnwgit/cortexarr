import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { allTimeZones, setTimeZone } from '../utils/time'
import PageSpinner from '../components/PageSpinner'
import Row from '../components/SettingsRow'

type Settings = Record<string, any>

// Time zone, retention and self-update — everything that isn't about a
// notification channel (those moved to their own Notifications tab).
export default function SettingsGeneral() {
  const [settings, setSettings] = useState<Settings>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

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
      await api.post('/settings/bulk', {
        timezone: settings.timezone ?? '',
        health_retention_days: settings.health_retention_days ?? 30,
        self_update_mode: settings.self_update_mode || 'manual',
        self_update_window_start: settings.self_update_window_start || '02:00',
        self_update_window_end: settings.self_update_window_end || '04:00',
      })
      setTimeZone(settings.timezone)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <PageSpinner />

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="bg-slate-925 border border-slate-800 rounded-xl p-4 space-y-3">
        <Row label="Time zone (for every time shown, and alert messages)">
          <select className="input" value={settings.timezone || ''} onChange={(e) => set('timezone', e.target.value)}>
            <option value="">Browser default — each viewer's own ({Intl.DateTimeFormat().resolvedOptions().timeZone})</option>
            {allTimeZones().map((z) => (
              <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>
            ))}
          </select>
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
