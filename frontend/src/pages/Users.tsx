import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import ConfirmDeleteModal from '../components/ConfirmDeleteModal'
import { fmtDateTime } from '../utils/time'

type Role = 'admin' | 'analyst' | 'viewer'

interface AppUser {
  id: number
  username: string
  email: string
  role: Role
  is_active: boolean
  created_at: string
  last_login: string | null
}

const ROLES: { key: Role; label: string }[] = [
  { key: 'admin', label: 'Admin' },
  { key: 'analyst', label: 'Analyst' },
  { key: 'viewer', label: 'Viewer' },
]

const EMPTY_FORM = { username: '', email: '', password: '', role: 'viewer' as Role }

// Admin user management. Every write here is admin-only on the server too,
// and the server refuses anything that would leave no active admin —
// demoting, deactivating or deleting the last one — so this page can just
// surface whatever it says rather than guessing the rule itself.
export default function Users() {
  const { user: me } = useAuth()
  const [users, setUsers] = useState<AppUser[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [rowBusy, setRowBusy] = useState<Record<number, boolean>>({})
  const [rowError, setRowError] = useState<Record<number, string>>({})
  const [resetting, setResetting] = useState<AppUser | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [deleting, setDeleting] = useState<AppUser | null>(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    setUsers(await api.get<AppUser[]>('/users/'))
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function create() {
    setSaving(true)
    setError('')
    try {
      await api.post('/users/', form)
      setForm(EMPTY_FORM)
      setShowForm(false)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create user')
    } finally {
      setSaving(false)
    }
  }

  async function patch(u: AppUser, body: Partial<Pick<AppUser, 'role' | 'is_active'>>) {
    setRowBusy((b) => ({ ...b, [u.id]: true }))
    setRowError((e) => ({ ...e, [u.id]: '' }))
    try {
      await api.patch(`/users/${u.id}`, body)
      await load()
    } catch (err) {
      setRowError((e) => ({ ...e, [u.id]: err instanceof ApiError ? err.message : 'Failed to save' }))
    } finally {
      setRowBusy((b) => ({ ...b, [u.id]: false }))
    }
  }

  async function resetPassword() {
    if (!resetting) return
    setBusy(true)
    try {
      await api.put(`/users/${resetting.id}/password`, { new_password: newPassword })
      setResetting(null)
      setNewPassword('')
    } catch (err) {
      setRowError((e) => ({ ...e, [resetting.id]: err instanceof ApiError ? err.message : 'Failed to reset' }))
      setResetting(null)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!deleting) return
    setBusy(true)
    try {
      await api.delete(`/users/${deleting.id}`)
      setDeleting(null)
      await load()
    } catch (err) {
      setRowError((e) => ({ ...e, [deleting.id]: err instanceof ApiError ? err.message : 'Failed to delete' }))
      setDeleting(null)
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <p className="text-slate-400 text-sm">Loading…</p>

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-slate-100">Users</h2>
        {!showForm && (
          <button
            onClick={() => {
              setShowForm(true)
              setError('')
            }}
            className="rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium px-4 py-2"
          >
            New user
          </button>
        )}
      </div>

      {showForm && (
        <div className="bg-slate-925 border border-slate-800 rounded-xl p-4 mb-4 space-y-3">
          {error && <div className="text-sm text-red-300 bg-red-950/50 border border-red-900 rounded-lg px-3 py-2">{error}</div>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs text-slate-400 mb-1">Username</span>
              <input
                className="input"
                autoComplete="off"
                maxLength={64}
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="block text-xs text-slate-400 mb-1">Email</span>
              <input
                className="input"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="block text-xs text-slate-400 mb-1">Password</span>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="block text-xs text-slate-400 mb-1">Role</span>
              <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
                {ROLES.map((r) => (
                  <option key={r.key} value={r.key}>{r.label}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowForm(false)} className="btn-secondary">Cancel</button>
            <button
              onClick={create}
              disabled={saving || !form.username || !form.email || form.password.length < 8}
              className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2"
            >
              {saving ? 'Creating…' : 'Create user'}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {users.map((u) => (
          <div key={u.id} className="bg-slate-925 border border-slate-800 rounded-xl p-4">
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 font-medium text-slate-100">
                  {u.username}
                  {u.id === me?.id && <span className="metadata-pill text-xs">you</span>}
                  {!u.is_active && <span className="metadata-pill text-xs text-slate-400">inactive</span>}
                </div>
                <div className="text-xs text-slate-400 mt-0.5">
                  {u.email} · created {fmtDateTime(new Date(u.created_at.replace(' ', 'T') + 'Z'))} · last signed in{' '}
                  {u.last_login ? fmtDateTime(new Date(u.last_login.replace(' ', 'T') + 'Z')) : 'never'}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="input w-32"
                  value={u.role}
                  disabled={rowBusy[u.id]}
                  onChange={(e) => patch(u, { role: e.target.value as Role })}
                >
                  {ROLES.map((r) => (
                    <option key={r.key} value={r.key}>{r.label}</option>
                  ))}
                </select>
                <button onClick={() => patch(u, { is_active: !u.is_active })} disabled={rowBusy[u.id]} className="btn-secondary">
                  {u.is_active ? 'Deactivate' : 'Reactivate'}
                </button>
                <button onClick={() => setResetting(u)} className="btn-secondary">
                  Reset password
                </button>
                <button
                  onClick={() => setDeleting(u)}
                  className="rounded-lg border border-red-900 text-red-300 hover:bg-red-950/50 text-sm px-3 py-1.5"
                >
                  Delete
                </button>
              </div>
            </div>
            {rowError[u.id] && <p className="text-sm text-red-300 mt-2">{rowError[u.id]}</p>}
          </div>
        ))}
      </div>

      {resetting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-sm bg-slate-925 border border-slate-800 rounded-xl p-6 shadow-xl">
            <h3 className="text-base font-semibold text-slate-100 mb-2">Reset {resetting.username}'s password</h3>
            <p className="text-sm text-slate-300 mb-4">They'll need this new password next time they sign in.</p>
            <label className="block text-xs text-slate-400 mb-1">New password (at least 8 characters)</label>
            <input
              autoFocus
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="input w-full mb-4"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setResetting(null)
                  setNewPassword('')
                }}
                disabled={busy}
                className="btn-secondary"
              >
                Cancel
              </button>
              <button
                onClick={resetPassword}
                disabled={busy || newPassword.length < 8}
                className={clsx(
                  'rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2',
                )}
              >
                {busy ? 'Saving…' : 'Reset password'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleting && (
        <ConfirmDeleteModal
          title={`Delete ${deleting.username}?`}
          warning="Their API tokens and notification preferences go with them."
          busy={busy}
          onConfirm={remove}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  )
}
