import { useState } from 'react'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'

export interface DuplicateScanConfig {
  enabled?: boolean
  ssh_host?: string
  ssh_user?: string
  ssh_port?: number
  key_path?: string
  paths?: string[]
  interval_minutes?: number
}

// One Sonarr or Radarr service's duplicate-file scan: where its files are
// (an SSH login to the machine that holds them, and the folders there). Sonarr
// looks for the same episode (S##E##) in two files, Radarr for a movie folder
// with two video files. Opens under the service's row in Settings → Services.
export default function DuplicateScanSettings({
  serviceId, type, config, onSaved,
}: { serviceId: number; type: string; config?: DuplicateScanConfig; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(!!config?.enabled)
  const [host, setHost] = useState(config?.ssh_host ?? '')
  const [user, setUser] = useState(config?.ssh_user ?? '')
  const [port, setPort] = useState(config?.ssh_port ?? 22)
  const [key, setKey] = useState(config?.key_path ?? '')
  const [paths, setPaths] = useState((config?.paths ?? []).join('\n'))
  const [minutes, setMinutes] = useState(config?.interval_minutes ?? 360)
  const [busy, setBusy] = useState('')
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const body = () => ({
    enabled, ssh_host: host.trim(), ssh_user: user.trim(), ssh_port: port, key_path: key.trim(),
    paths: paths.split('\n').map((l) => l.trim()).filter(Boolean), interval_minutes: minutes,
  })

  async function test() {
    setBusy('test')
    setResult(null)
    try {
      setResult(await api.post<{ ok: boolean; message: string }>('/duplicates/test', { duplicate_scan: body() }))
    } catch (err) {
      setResult({ ok: false, message: err instanceof ApiError ? err.message : 'Test failed' })
    } finally {
      setBusy('')
    }
  }

  async function save() {
    setBusy('save')
    setResult(null)
    try {
      await api.patch(`/services/${serviceId}`, { duplicate_scan: body() })
      setResult({ ok: true, message: enabled ? 'Saved — the first scan has started.' : 'Saved — scanning is off.' })
      onSaved()
    } catch (err) {
      setResult({ ok: false, message: err instanceof ApiError ? err.message : 'Could not save' })
    } finally {
      setBusy('')
    }
  }

  const what = type === 'radarr' ? 'a movie folder with more than one video file' : 'the same episode (S##E##) in more than one file'

  return (
    <div className="mt-3 bg-slate-950 border border-slate-800 rounded-lg p-3 space-y-3" onClick={(e) => e.stopPropagation()}>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-0.5 accent-violet-500" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span className="text-sm text-slate-300">
          Look for duplicate files
          <span className="block text-xs text-slate-400">
            Logs in over SSH to the machine that holds this service's files and flags {what}. Anything found shows on
            the Dashboard and the Duplicates tab, and can alert.
          </span>
        </span>
      </label>

      {enabled && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Host (name or address)">
            <input className="input" placeholder="nas.example.com" value={host} onChange={(e) => setHost(e.target.value)} />
          </Field>
          <Field label="SSH user">
            <input className="input" autoComplete="off" value={user} onChange={(e) => setUser(e.target.value)} />
          </Field>
          <Field label="SSH port">
            <input className="input" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} />
          </Field>
          <Field label="SSH key file (path on the Cortexarr host)">
            <input className="input" placeholder="/data/ssh/duplicates_key" value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
          <Field label={type === 'radarr' ? 'Movie folders (one per line)' : 'Series folders (one per line)'}>
            <textarea className="input font-mono" rows={3} placeholder={type === 'radarr' ? '/share/Movies' : '/share/Series'} value={paths} onChange={(e) => setPaths(e.target.value)} />
          </Field>
          <Field label="Scan every (minutes)">
            <input className="input" type="number" min={10} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
          </Field>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {enabled && (
          <button onClick={test} disabled={busy !== ''} className="btn-secondary">
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
        )}
        <button onClick={save} disabled={busy !== ''} className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-1.5">
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
        {result && <span className={clsx('text-xs', result.ok ? 'text-teal-300' : 'text-red-300')}>{result.ok ? '✓ ' : '✗ '}{result.message}</span>}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm text-slate-400 mb-1">{label}</span>
      {children}
    </label>
  )
}
