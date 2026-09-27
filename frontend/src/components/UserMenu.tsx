import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { api, ApiError } from '../api/client'

export default function UserMenu() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Close on outside click.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
        setChangingPassword(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  function resetForm() {
    setChangingPassword(false)
    setCurrentPassword('')
    setNewPassword('')
    setError('')
    setSuccess(false)
  }

  async function submitPasswordChange(e: FormEvent) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      await api.put('/users/me/password', { current_password: currentPassword, new_password: newPassword })
      setSuccess(true)
      setCurrentPassword('')
      setNewPassword('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change password')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-sm text-slate-400 hover:text-slate-200 rounded-lg px-2 py-1.5 hover:bg-slate-900"
      >
        <span>{user?.username}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" className="opacity-60">
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-72 bg-slate-925 border border-slate-800 rounded-xl shadow-xl p-3 z-20">
          {!changingPassword ? (
            <div className="space-y-1">
              <div className="px-2 py-1 text-xs text-slate-500">
                Signed in as <span className="text-slate-300">{user?.username}</span> ({user?.role})
              </div>
              {/* Services live here rather than as a top tab — managing them
                  is occasional, the Dashboard is where they're watched. */}
              <div className="border-t border-slate-800 pt-1 mt-1">
                <div className="px-2 pt-1 pb-0.5 text-xs font-medium uppercase tracking-wide text-slate-400">Services</div>
                <button
                  onClick={() => {
                    setOpen(false)
                    navigate('/services')
                  }}
                  className="w-full text-left rounded-lg px-2 py-1.5 text-sm text-slate-200 hover:bg-slate-900"
                >
                  Manage services
                </button>
                {user?.role === 'admin' && (
                  <button
                    onClick={() => {
                      setOpen(false)
                      navigate('/services?add=1')
                    }}
                    className="w-full text-left rounded-lg px-2 py-1.5 text-sm text-slate-200 hover:bg-slate-900"
                  >
                    Add service
                  </button>
                )}
              </div>
              <div className="border-t border-slate-800 pt-1 mt-1" />
              <button
                onClick={() => {
                  setOpen(false)
                  navigate('/alerts')
                }}
                className="w-full text-left rounded-lg px-2 py-1.5 text-sm text-slate-200 hover:bg-slate-900"
              >
                Alerts
              </button>
              <button
                onClick={() => {
                  setOpen(false)
                  navigate('/settings')
                }}
                className="w-full text-left rounded-lg px-2 py-1.5 text-sm text-slate-200 hover:bg-slate-900"
              >
                Settings
              </button>
              <button
                onClick={() => {
                  setOpen(false)
                  navigate('/tokens')
                }}
                className="w-full text-left rounded-lg px-2 py-1.5 text-sm text-slate-200 hover:bg-slate-900"
              >
                API tokens
              </button>
              <button
                onClick={() => setChangingPassword(true)}
                className="w-full text-left rounded-lg px-2 py-1.5 text-sm text-slate-200 hover:bg-slate-900"
              >
                Change password
              </button>
              <button
                onClick={() => logout()}
                className="w-full text-left rounded-lg px-2 py-1.5 text-sm text-red-300 hover:bg-red-950/50"
              >
                Log out
              </button>
            </div>
          ) : success ? (
            <div className="space-y-3">
              <p className="text-sm text-teal-300">Password updated.</p>
              <button onClick={resetForm} className="btn-secondary w-full">Close</button>
            </div>
          ) : (
            <form onSubmit={submitPasswordChange} className="space-y-2">
              {error && (
                <div className="text-xs text-red-300 bg-red-950/50 border border-red-900 rounded-lg px-2 py-1.5">
                  {error}
                </div>
              )}
              <label className="block">
                <span className="block text-xs text-slate-400 mb-1">Current password</span>
                <input
                  type="password"
                  className="input"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  autoFocus
                />
              </label>
              <label className="block">
                <span className="block text-xs text-slate-400 mb-1">New password</span>
                <input
                  type="password"
                  className="input"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </label>
              <div className="flex gap-2 pt-1">
                <button
                  type="submit"
                  disabled={submitting || !currentPassword || newPassword.length < 8}
                  className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-3 py-1.5 flex-1"
                >
                  {submitting ? 'Saving…' : 'Save'}
                </button>
                <button type="button" onClick={resetForm} className="btn-secondary">Cancel</button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  )
}
