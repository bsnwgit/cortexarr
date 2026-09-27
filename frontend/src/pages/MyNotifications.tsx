import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import { resultText } from '../utils/notifyResult'

type Channel = 'email' | 'webhook' | 'ntfy' | 'sms'

interface Pref {
  channel: Channel
  enabled: boolean
  target: string
}

const CHANNELS: { key: Channel; label: string; field: string; placeholder: string; hint: string }[] = [
  { key: 'email', label: 'Email', field: 'Email address', placeholder: 'you@example.com', hint: '' },
  {
    key: 'webhook',
    label: 'Webhook (Slack / Discord)',
    field: 'Webhook URL',
    placeholder: 'https://hooks.example.com/…',
    hint: 'Your own Slack or Discord incoming-webhook URL.',
  },
  { key: 'ntfy', label: 'Push (ntfy)', field: 'Topic', placeholder: 'my-alerts', hint: 'Subscribe to this topic in the ntfy app.' },
  {
    key: 'sms',
    label: 'SMS',
    field: 'Phone number',
    placeholder: '+15551234567',
    hint: 'International format, starting with +.',
  },
]

// Your own notification channels (the per-user layer, scope #13): alerts go
// here as well as to the recipients an admin set under Settings. A channel
// only works if the admin has set it up there too.
export default function MyNotifications() {
  const [prefs, setPrefs] = useState<Record<Channel, Pref>>(() =>
    Object.fromEntries(CHANNELS.map((c) => [c.key, { channel: c.key, enabled: false, target: '' }])) as Record<
      Channel,
      Pref
    >,
  )
  const [globalOn, setGlobalOn] = useState<Record<string, boolean>>({})
  const [status, setStatus] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [busy, setBusy] = useState('')

  async function load() {
    const [mine, settings] = await Promise.all([
      api.get<Pref[]>('/users/me/notifications'),
      api.get<Record<string, unknown>>('/settings/'),
    ])
    setPrefs((p) => {
      const next = { ...p }
      for (const m of mine) next[m.channel] = { ...m, enabled: !!m.enabled }
      return next
    })
    setGlobalOn(Object.fromEntries(CHANNELS.map((c) => [c.key, !!settings[`notify_${c.key}_enabled`]])))
  }

  useEffect(() => {
    load()
  }, [])

  function set(channel: Channel, change: Partial<Pref>) {
    setPrefs((p) => ({ ...p, [channel]: { ...p[channel], ...change } }))
    setStatus((s) => ({ ...s, [channel]: undefined as unknown as { ok: boolean; text: string } }))
  }

  async function save(channel: Channel) {
    setBusy(channel)
    try {
      await api.put('/users/me/notifications', prefs[channel])
      setStatus((s) => ({ ...s, [channel]: { ok: true, text: 'Saved' } }))
    } catch (err) {
      setStatus((s) => ({ ...s, [channel]: { ok: false, text: err instanceof ApiError ? err.message : 'Failed to save' } }))
    } finally {
      setBusy('')
    }
  }

  async function test(channel: Channel) {
    setBusy(channel)
    try {
      await api.put('/users/me/notifications', prefs[channel])
      const res = await api.post<{ status: string; detail: string }>('/users/me/notifications/test', { channel })
      setStatus((s) => ({ ...s, [channel]: { ok: res.status === 'sent', text: resultText(res) } }))
    } catch (err) {
      setStatus((s) => ({ ...s, [channel]: { ok: false, text: err instanceof ApiError ? err.message : 'Test failed' } }))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="max-w-3xl">
      <h2 className="text-lg font-semibold text-slate-100 mb-1">My notifications</h2>
      <p className="text-sm text-slate-300 mb-4">
        Where <em>you</em> get alerts. They also go to whoever an admin set under Settings; what triggers an alert is set
        by the rules under <Link to="/alerts" className="underline hover:text-slate-100">Alerts</Link>.
      </p>
      <div className="space-y-3">
        {CHANNELS.map((c) => {
          const p = prefs[c.key]
          return (
            <div key={c.key} className="bg-slate-925 border border-slate-800 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 font-medium text-slate-100">
                  <input
                    type="checkbox"
                    className="accent-violet-500"
                    checked={p.enabled}
                    onChange={(e) => set(c.key, { enabled: e.target.checked })}
                  />
                  {c.label}
                </label>
                {globalOn[c.key] === false && (
                  <span className="text-xs text-amber-300">Not set up by an admin yet — nothing will be sent</span>
                )}
              </div>
              <label className="block">
                <span className="block text-xs text-slate-400 mb-1">{c.field}</span>
                <input
                  className="input"
                  maxLength={500}
                  placeholder={c.placeholder}
                  value={p.target}
                  onChange={(e) => set(c.key, { target: e.target.value })}
                />
                {c.hint && <span className="block text-xs text-slate-400 mt-1">{c.hint}</span>}
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => save(c.key)}
                  disabled={busy === c.key}
                  className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-3 py-1.5"
                >
                  Save
                </button>
                <button onClick={() => test(c.key)} disabled={busy === c.key || !p.target.trim()} className="btn-secondary">
                  Send me a test
                </button>
                {status[c.key] && (
                  <span className={clsx('text-sm', status[c.key].ok ? 'text-teal-300' : 'text-red-300')}>
                    {status[c.key].text}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
