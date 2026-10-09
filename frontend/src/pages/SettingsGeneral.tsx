import { useEffect, useState } from 'react'
import { api, ApiError } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { allTimeZones, setTimeZone } from '../utils/time'
import PageSpinner from '../components/PageSpinner'
import Row from '../components/SettingsRow'

type Settings = Record<string, any>

interface TlsStatus {
  active_enabled: boolean
  pending_enabled: boolean
  restart_required: boolean
  has_certificate: boolean
  subject: string | null
  not_after: string | null
  expired: boolean
}

interface ImportResult {
  services_added: string[]
  services_skipped: string[]
  services_failed: { name: string; detail: string }[]
  settings_applied: string[]
  rules_added: string[]
  rules_skipped: string[]
  rules_failed: { name: string; detail: string }[]
}

interface UpdateStatus {
  current_version: string
  latest_tag: string | null
  latest_url: string | null
  update_available: boolean
  checked_at: string | null
  last_error: string
  last_applied_tag: string | null
  last_applied_at: string | null
}

// Time zone, retention and self-update — everything that isn't about a
// notification channel (those moved to their own Notifications tab).
export default function SettingsGeneral() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
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
        <div className="pt-1">
          <button onClick={save} disabled={saving} className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2">
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </div>

      <UpdateCheck isAdmin={isAdmin} />

      {isAdmin && <ServerTls />}
      {isAdmin && <Backup />}
    </div>
  )
}

// Version + "is a newer release out" — separate from the mode/window Rows
// above since it's status, not a setting to save.
function UpdateCheck({ isAdmin }: { isAdmin: boolean }) {
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [restarting, setRestarting] = useState(false)

  async function load() {
    try {
      setUpdate(await api.get<UpdateStatus>('/settings/update-status'))
    } catch {
      // Non-fatal — the rest of the settings page still works.
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function checkNow() {
    setChecking(true)
    setError('')
    try {
      setUpdate(await api.post<UpdateStatus>('/settings/update-check', {}))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Check failed')
    } finally {
      setChecking(false)
    }
  }

  // The server downloads the release, swaps it in, then exits so systemd
  // starts the new code. Poll until the version changes, then reload so the
  // browser picks up the new frontend.
  async function updateNow() {
    if (!update) return
    setError('')
    setConfirming(false)
    try {
      await api.post('/settings/update-apply', {})
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Update failed')
      return
    }
    setRestarting(true)
    const before = update.current_version
    const started = Date.now()
    const timer = window.setInterval(async () => {
      try {
        const now = await api.get<UpdateStatus>('/settings/update-status')
        if (now.current_version !== before) {
          window.clearInterval(timer)
          window.location.reload()
        }
      } catch {
        // Expected while the service restarts.
      }
      if (Date.now() - started > 120_000) {
        window.clearInterval(timer)
        setRestarting(false)
        setError('Still waiting for Cortexarr to come back — reload this page in a moment.')
      }
    }, 2000)
  }

  if (!update) return null

  return (
    <div className="bg-slate-925 border border-slate-800 rounded-xl p-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-slate-100">
          Cortexarr <span className="text-slate-400">v{update.current_version}</span>
        </div>
        {isAdmin && (
          <button onClick={checkNow} disabled={checking} className="text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50 underline">
            {checking ? 'Checking…' : 'Check now'}
          </button>
        )}
      </div>
      {update.update_available ? (
        <div className="space-y-2">
          <p className="text-xs text-teal-300">
            {update.latest_tag} is available.{' '}
            {update.latest_url && (
              <a href={update.latest_url} target="_blank" rel="noreferrer" className="underline hover:text-teal-200">
                Release notes
              </a>
            )}
          </p>
          {isAdmin && restarting && <p className="text-xs text-slate-300">Updating — Cortexarr is restarting, this page will reload on its own…</p>}
          {isAdmin && !restarting && !confirming && (
            <button
              onClick={() => setConfirming(true)}
              className="px-3 py-1.5 rounded-lg text-sm border border-teal-600/40 bg-teal-600/20 text-teal-300 hover:bg-teal-600/30"
            >
              Update now
            </button>
          )}
          {isAdmin && !restarting && confirming && (
            <div className="space-y-2">
              <p className="text-xs text-slate-300">
                Download {update.latest_tag} and restart Cortexarr? It will be unavailable for a few seconds.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={updateNow}
                  className="px-3 py-1.5 rounded-lg text-sm border border-teal-600/40 bg-teal-600/20 text-teal-300 hover:bg-teal-600/30"
                >
                  Update and restart
                </button>
                <button onClick={() => setConfirming(false)} className="px-3 py-1.5 rounded-lg text-sm text-slate-400 hover:text-slate-200">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-slate-400">Up to date{update.checked_at ? ` — last checked ${new Date(update.checked_at).toLocaleString()}` : ''}.</p>
      )}
      {update.last_applied_tag && (
        <p className="text-xs text-slate-500">Last applied: {update.last_applied_tag} ({update.last_applied_at ? new Date(update.last_applied_at).toLocaleString() : 'unknown time'})</p>
      )}
      {update.last_error && <p className="text-xs text-red-300">{update.last_error}</p>}
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  )
}

// HTTPS for the whole app (web UI, API, and the MCP server at /mcp all
// share one listener — there's no per-route scheme). Added because a
// remote MCP client refuses a plain-HTTP endpoint. Turning it on/off, or
// replacing the certificate, only takes effect after a restart, same as
// any other startup setting — see app/tls_state.py.
function ServerTls() {
  const [status, setStatus] = useState<TlsStatus | null>(null)
  const [cert, setCert] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    try {
      setStatus(await api.get<TlsStatus>('/server/tls'))
    } catch {
      // Admin-only endpoint; a stale session mid-demotion shouldn't break the page.
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function uploadCertificate() {
    setBusy(true)
    setError('')
    try {
      setStatus(await api.post<TlsStatus>('/server/tls/certificate', { certificate: cert, private_key: key }))
      setCert('')
      setKey('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save the certificate')
    } finally {
      setBusy(false)
    }
  }

  async function setEnabled(enabled: boolean) {
    setBusy(true)
    setError('')
    try {
      setStatus(await api.put<TlsStatus>('/server/tls/enabled', { enabled }))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change this')
    } finally {
      setBusy(false)
    }
  }

  async function removeCertificate() {
    setBusy(true)
    setError('')
    try {
      setStatus(await api.delete<TlsStatus>('/server/tls/certificate'))
    } finally {
      setBusy(false)
    }
  }

  if (!status) return null

  return (
    <div className="bg-slate-925 border border-slate-800 rounded-xl p-4 space-y-3">
      <h3 className="text-sm font-semibold text-slate-200">Server (HTTPS)</h3>
      <p className="text-xs text-slate-400">
        Cortexarr is currently serving over <span className="text-slate-200 font-medium">{status.active_enabled ? 'HTTPS' : 'HTTP'}</span>.
        {status.restart_required && (
          <> Set to <span className="text-slate-200 font-medium">{status.pending_enabled ? 'HTTPS' : 'HTTP'}</span> at the next restart.</>
        )}
        {' '}This covers the web UI, the API, and the MCP server at <code className="text-slate-300">/mcp</code> — they share one listener.
      </p>

      {error && <div className="text-sm text-red-300 bg-red-950/50 border border-red-900 rounded-lg px-3 py-2">{error}</div>}

      <div className="text-sm text-slate-300">
        {status.has_certificate ? (
          <>
            Certificate on file: <span className="text-slate-200">{status.subject}</span>, expires{' '}
            <span className={status.expired ? 'text-red-300' : 'text-slate-200'}>
              {status.not_after ? new Date(status.not_after).toLocaleDateString() : '—'}
            </span>
            {status.expired && ' (expired)'}
          </>
        ) : (
          'No certificate uploaded yet.'
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block">
          <span className="block text-xs text-slate-400 mb-1">Certificate (PEM)</span>
          <textarea
            className="input font-mono text-xs h-28"
            placeholder={'-----BEGIN CERTIFICATE-----'}
            value={cert}
            onChange={(e) => setCert(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-xs text-slate-400 mb-1">Private key (PEM, unencrypted)</span>
          <textarea
            className="input font-mono text-xs h-28"
            placeholder="Paste the private key (PEM)"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={uploadCertificate}
          disabled={busy || !cert.trim() || !key.trim()}
          className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2"
        >
          {busy ? 'Working…' : 'Save certificate'}
        </button>
        {status.has_certificate && !status.pending_enabled && (
          <button
            onClick={() => setEnabled(true)}
            disabled={busy || status.expired}
            className="btn-secondary disabled:opacity-50"
            title={status.expired ? 'That certificate has expired' : undefined}
          >
            Turn on HTTPS
          </button>
        )}
        {status.pending_enabled && (
          <button onClick={() => setEnabled(false)} disabled={busy} className="btn-secondary disabled:opacity-50">
            Turn off HTTPS
          </button>
        )}
        {status.has_certificate && (
          <button
            onClick={removeCertificate}
            disabled={busy}
            className="rounded-lg border border-red-900 text-red-300 hover:bg-red-950/50 text-sm px-3 py-1.5 disabled:opacity-50"
          >
            Remove certificate
          </button>
        )}
      </div>
      {status.restart_required && (
        <p className="text-xs text-slate-400">
          Run <code className="text-slate-300">sudo systemctl restart cortexarr</code> (or your own restart command) for this to take effect.
        </p>
      )}
    </div>
  )
}

const MIN_PASSPHRASE = 8

// Export/import the service list and notification configuration (not the
// database) so a setup can be backed up or moved. A service or rule whose
// name already exists is left alone rather than duplicated, so importing
// the same file twice is safe. Including credentials always encrypts the
// file (password-based); encrypting a credentials-free export is optional.
function Backup() {
  const [includeCreds, setIncludeCreds] = useState(false)
  const [encrypt, setEncrypt] = useState(false)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importParsed, setImportParsed] = useState<any>(null)
  const [importPassphrase, setImportPassphrase] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [importError, setImportError] = useState('')

  const willEncrypt = encrypt || includeCreds
  const passwordValid = password.length >= MIN_PASSPHRASE && password === confirmPassword

  async function doExport() {
    setExporting(true)
    setExportError('')
    try {
      const data = await api.post<Record<string, unknown>>('/config/export', {
        include_credentials: includeCreds,
        passphrase: willEncrypt ? password : undefined,
      })
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `cortexarr-config-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      setPassword('')
      setConfirmPassword('')
    } catch (err) {
      setExportError(err instanceof ApiError ? err.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  async function onFileChosen(file: File | null) {
    setImportFile(file)
    setImportParsed(null)
    setImportPassphrase('')
    setImportResult(null)
    setImportError('')
    if (!file) return
    try {
      setImportParsed(JSON.parse(await file.text()))
    } catch {
      setImportError('Not valid JSON')
    }
  }

  const isEncryptedImport = importParsed?.cortexarr_encrypted_export === 1

  async function doImport() {
    if (!importParsed) return
    setImporting(true)
    setImportError('')
    setImportResult(null)
    try {
      let body: Record<string, unknown>
      if (isEncryptedImport) {
        body = { encrypted: importParsed, passphrase: importPassphrase }
      } else {
        if (importParsed.cortexarr_config_export !== 1) throw new Error('Not a Cortexarr config export')
        body = {
          services: importParsed.services ?? [],
          notification_settings: importParsed.notification_settings ?? {},
          alert_rules: importParsed.alert_rules ?? [],
        }
      }
      const result = await api.post<ImportResult>('/config/import', body)
      setImportResult(result)
      setImportFile(null)
      setImportParsed(null)
      setImportPassphrase('')
    } catch (err) {
      setImportError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="bg-slate-925 border border-slate-800 rounded-xl p-4 space-y-3">
      <h3 className="text-sm font-semibold text-slate-200">Backup</h3>
      <p className="text-xs text-slate-400">
        Export the service list and notification configuration — not the database — so a setup
        can be backed up or moved. API keys and channel secrets are left out unless you choose to
        include them.
      </p>

      {exportError && <p className="text-sm text-red-300">{exportError}</p>}

      <label className="flex items-center gap-2 text-sm text-slate-200">
        <input
          type="checkbox"
          className="accent-violet-500"
          checked={includeCreds}
          onChange={(e) => setIncludeCreds(e.target.checked)}
        />
        Include API keys and channel secrets
      </label>

      <label className="flex items-center gap-2 text-sm text-slate-200">
        <input
          type="checkbox"
          className="accent-violet-500"
          checked={willEncrypt}
          disabled={includeCreds}
          onChange={(e) => setEncrypt(e.target.checked)}
        />
        Encrypt this file with a password{includeCreds && ' (required with credentials included)'}
      </label>

      {willEncrypt && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input
            className="input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <input
            className="input"
            type="password"
            placeholder="Confirm password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
          {password && password.length < MIN_PASSPHRASE && (
            <span className="text-xs text-red-300 sm:col-span-2">At least {MIN_PASSPHRASE} characters.</span>
          )}
          {password && confirmPassword && password !== confirmPassword && (
            <span className="text-xs text-red-300 sm:col-span-2">Passwords don't match.</span>
          )}
          <span className="text-xs text-slate-400 sm:col-span-2">
            Cortexarr doesn't store this password — forgetting it means the file can't be read back.
          </span>
        </div>
      )}

      <button
        onClick={doExport}
        disabled={exporting || (willEncrypt && !passwordValid)}
        className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2"
      >
        {exporting ? 'Exporting…' : 'Export configuration'}
      </button>

      <div className="border-t border-slate-800 pt-3 space-y-2">
        <label className="block">
          <span className="block text-xs text-slate-400 mb-1">Import configuration</span>
          <input
            type="file"
            accept="application/json"
            onChange={(e) => onFileChosen(e.target.files?.[0] ?? null)}
            className="input"
          />
        </label>
        {isEncryptedImport && (
          <input
            className="input"
            type="password"
            placeholder="Password for this file"
            value={importPassphrase}
            onChange={(e) => setImportPassphrase(e.target.value)}
          />
        )}
        {importError && <p className="text-sm text-red-300">{importError}</p>}
        <button
          onClick={doImport}
          disabled={!importParsed || importing || (isEncryptedImport && !importPassphrase)}
          className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2"
        >
          {importing ? 'Importing…' : 'Import'}
        </button>
        {importResult && (
          <div className="text-xs text-slate-300 space-y-1">
            <p>
              {importResult.services_added.length} service{importResult.services_added.length === 1 ? '' : 's'} added
              {importResult.services_skipped.length ? `, ${importResult.services_skipped.length} already existed` : ''}
              {importResult.services_failed.length ? `, ${importResult.services_failed.length} failed` : ''}.
            </p>
            <p>
              {importResult.rules_added.length} rule{importResult.rules_added.length === 1 ? '' : 's'} added
              {importResult.rules_skipped.length ? `, ${importResult.rules_skipped.length} already existed` : ''}
              {importResult.rules_failed.length ? `, ${importResult.rules_failed.length} failed` : ''}.
            </p>
            <p>{importResult.settings_applied.length} notification setting{importResult.settings_applied.length === 1 ? '' : 's'} applied.</p>
            {[...importResult.services_failed, ...importResult.rules_failed].map((f, i) => (
              <p key={i} className="text-red-300">
                {f.name}: {f.detail}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
