import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import ConfirmDeleteModal from '../components/ConfirmDeleteModal'

interface Token {
  id: number
  user_id: number
  username: string
  name: string
  prefix: string
  access: 'read' | 'write'
  allow_destructive: boolean
  created_at: string
  expires_at: string | null
  last_used_at: string | null
}

const EMPTY_FORM = { name: '', access: 'read' as 'read' | 'write', allow_destructive: false, expires_days: 90 }

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs text-slate-400 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate-400 mt-1">{hint}</span>}
    </label>
  )
}

// SQLite datetimes are UTC without a zone marker.
function fmt(v: string | null, fallback: string) {
  if (!v) return fallback
  const d = new Date(v.replace(' ', 'T') + 'Z')
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString()
}

// Personal API tokens for the MCP endpoint. A token is shown once, when it's
// made — only its hash is kept — so the new-token panel says so plainly.
export default function ApiTokens() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [tokens, setTokens] = useState<Token[]>([])
  const [form, setForm] = useState(EMPTY_FORM)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [made, setMade] = useState<{ name: string; token: string } | null>(null)
  const [copied, setCopied] = useState('')
  const [revoking, setRevoking] = useState<Token | null>(null)
  const [busy, setBusy] = useState(false)

  const mcpUrl = `${window.location.origin}/mcp`

  async function load() {
    setTokens(await api.get<Token[]>('/tokens/'))
  }

  useEffect(() => {
    load()
  }, [])

  async function create() {
    setSaving(true)
    setError('')
    try {
      const res = await api.post<Token & { token: string }>('/tokens/', form)
      setMade({ name: res.name, token: res.token })
      setForm(EMPTY_FORM)
      setShowForm(false)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create token')
    } finally {
      setSaving(false)
    }
  }

  async function revoke() {
    if (!revoking) return
    setBusy(true)
    try {
      await api.delete(`/tokens/${revoking.id}`)
      setRevoking(null)
      await load()
    } finally {
      setBusy(false)
    }
  }

  // navigator.clipboard only exists on https/localhost, and a homelab
  // install is usually plain http on a LAN address — so fall back to the
  // older execCommand copy, and say so if even that fails.
  async function copy(label: string, text: string) {
    let ok = false
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
        ok = true
      }
    } catch {
      ok = false
    }
    if (!ok) {
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      try {
        ok = document.execCommand('copy')
      } catch {
        ok = false
      }
      document.body.removeChild(area)
    }
    setCopied(ok ? label : `${label}-failed`)
    setTimeout(() => setCopied(''), ok ? 1500 : 4000)
  }

  function copyLabel(label: string) {
    if (copied === label) return 'Copied'
    if (copied === `${label}-failed`) return 'Select and copy'
    return 'Copy'
  }

  const clientConfig = made
    ? JSON.stringify(
        { mcpServers: { cortexarr: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${made.token}` } } } },
        null,
        2,
      )
    : ''

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-slate-100">API tokens</h2>
        {!showForm && (
          <button
            onClick={() => {
              setShowForm(true)
              setMade(null)
            }}
            className="rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium px-4 py-2"
          >
            New token
          </button>
        )}
      </div>

      <div className="bg-slate-925 border border-slate-800 rounded-xl p-4 mb-4 text-sm text-slate-300 space-y-2">
        <p>
          AI tools connect to Cortexarr over MCP at{' '}
          <code className="text-violet-300 break-all">{mcpUrl}</code>, with a token from this page. A token acts as
          you: a read token can only look; a write token can also change things (admins only); deleting anything
          needs a token that allows destructive tools.
        </p>
      </div>

      {made && (
        <div className="bg-slate-925 border border-teal-700/60 rounded-xl p-4 mb-4 space-y-3">
          <p className="text-sm text-teal-300 font-medium">
            Token “{made.name}” created. Copy it now — it won't be shown again.
          </p>
          <div className="flex gap-2 items-center">
            <code className="flex-1 min-w-0 break-all select-all rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-sm text-slate-100">
              {made.token}
            </code>
            <button onClick={() => copy('token', made.token)} className="btn-secondary shrink-0">
              {copyLabel('token')}
            </button>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-slate-400">MCP client config</span>
              <button onClick={() => copy('config', clientConfig)} className="btn-secondary">
                {copyLabel('config')}
              </button>
            </div>
            <pre className="select-all rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-xs text-slate-200 overflow-x-auto">
              {clientConfig}
            </pre>
          </div>
          <button onClick={() => setMade(null)} className="btn-secondary">Done</button>
        </div>
      )}

      {showForm && (
        <div className="bg-slate-925 border border-slate-800 rounded-xl p-4 mb-4 space-y-4">
          {error && (
            <div className="text-sm text-red-300 bg-red-950/50 border border-red-900 rounded-lg px-3 py-2">{error}</div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Name" hint="What will use it, e.g. “assistant on my laptop”.">
              <input
                className="input"
                maxLength={64}
                placeholder="My AI assistant"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="Expires after (days)" hint="0 means it never expires.">
              <input
                className="input"
                type="number"
                min={0}
                max={3650}
                value={form.expires_days}
                onChange={(e) => setForm({ ...form, expires_days: Number(e.target.value) })}
              />
            </Field>
            <Field label="Access">
              <select
                className="input"
                value={form.access}
                onChange={(e) => {
                  const access = e.target.value as 'read' | 'write'
                  setForm({ ...form, access, allow_destructive: access === 'write' && form.allow_destructive })
                }}
              >
                <option value="read">Read — look only</option>
                <option value="write" disabled={!isAdmin}>
                  Write — can change things{isAdmin ? '' : ' (admins only)'}
                </option>
              </select>
            </Field>
            {isAdmin && (
              <label className="flex items-start gap-2 sm:pt-6">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-violet-500"
                  disabled={form.access !== 'write'}
                  checked={form.allow_destructive}
                  onChange={(e) => setForm({ ...form, allow_destructive: e.target.checked })}
                />
                <span className="text-sm text-slate-300">
                  Allow destructive tools
                  <span className="block text-xs text-slate-400">
                    Deleting services, series, movies, files, and downloads. The AI tool won't ask before it does.
                  </span>
                </span>
              </label>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowForm(false)} className="btn-secondary">Cancel</button>
            <button
              onClick={create}
              disabled={saving || !form.name.trim()}
              className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2"
            >
              {saving ? 'Creating…' : 'Create token'}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {tokens.map((t) => (
          <div
            key={t.id}
            className="bg-slate-925 border border-slate-800 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 font-medium text-slate-100">
                {t.name}
                <span
                  className={clsx(
                    'metadata-pill text-xs',
                    t.access === 'write' ? 'text-violet-300' : 'text-teal-300',
                  )}
                >
                  {t.access}
                </span>
                {t.allow_destructive && <span className="metadata-pill text-xs text-red-300">destructive</span>}
              </div>
              <div className="text-xs text-slate-400 mt-0.5">
                <code>{t.prefix}…</code>
                {isAdmin && t.user_id !== user?.id && <> · {t.username}</>} · created {fmt(t.created_at, '—')} ·
                expires {fmt(t.expires_at, 'never')} · last used {fmt(t.last_used_at, 'never')}
              </div>
            </div>
            <button
              onClick={() => setRevoking(t)}
              className="self-start sm:self-auto rounded-lg border border-red-900 text-red-300 hover:bg-red-950/50 text-sm px-3 py-1.5"
            >
              Revoke
            </button>
          </div>
        ))}
        {tokens.length === 0 && !showForm && <p className="text-slate-400 text-sm">No tokens yet.</p>}
      </div>

      {revoking && (
        <ConfirmDeleteModal
          title={`Revoke “${revoking.name}”?`}
          warning="Anything using this token stops working immediately."
          confirmLabel="Revoke"
          busy={busy}
          onConfirm={revoke}
          onCancel={() => setRevoking(null)}
        />
      )}
    </div>
  )
}
