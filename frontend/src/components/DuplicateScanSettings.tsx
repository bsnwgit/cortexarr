import { useState } from 'react'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'

export interface FileAccessConfig {
  method?: 'none' | 'mount' | 'ssh'
  service_path?: string
  local_path?: string
  ssh?: { host?: string; port?: number; user?: string; key_path?: string; host_key?: string }
}

export interface DuplicateScanConfig {
  enabled?: boolean
  interval_minutes?: number
  show_hidden_cleanup?: boolean
  file_access?: FileAccessConfig
}

// One Sonarr or Radarr service's duplicate-file scan. It reads everything from
// the service itself — nothing to log in to or map. Sonarr looks for the same
// episode (S##E##) in two files, Radarr for a movie folder with two video
// files. Opens under the service's row in Settings → Services.
export default function DuplicateScanSettings({
  serviceId, type, config, onSaved,
}: { serviceId: number; type: string; config?: DuplicateScanConfig; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(config?.enabled ?? true)
  const [minutes, setMinutes] = useState(config?.interval_minutes ?? 360)
  const [cleanup, setCleanup] = useState(!!config?.show_hidden_cleanup)
  const fa = config?.file_access
  const [method, setMethod] = useState<'none' | 'mount' | 'ssh'>(fa?.method ?? 'none')
  const [servicePath, setServicePath] = useState(fa?.service_path ?? '')
  const [localPath, setLocalPath] = useState(fa?.local_path ?? '')
  const [host, setHost] = useState(fa?.ssh?.host ?? '')
  const [port, setPort] = useState(fa?.ssh?.port ?? 22)
  const [user, setUser] = useState(fa?.ssh?.user ?? '')
  const [keyPath, setKeyPath] = useState(fa?.ssh?.key_path ?? '')
  const [hostKey, setHostKey] = useState(fa?.ssh?.host_key ?? '')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  async function save() {
    setBusy(true)
    setResult(null)
    try {
      const file_access =
        method === 'none'
          ? { method }
          : {
              method, service_path: servicePath, local_path: localPath,
              ...(method === 'ssh' ? { ssh: { host, port, user, key_path: keyPath, host_key: hostKey } } : {}),
            }
      await api.patch(`/services/${serviceId}`, {
        duplicate_scan: { enabled, interval_minutes: minutes, show_hidden_cleanup: cleanup, ...(type === 'radarr' ? { file_access } : {}) },
      })
      setResult({ ok: true, message: enabled ? 'Saved — the first scan has started.' : 'Saved — scanning is off.' })
      onSaved()
    } catch (err) {
      setResult({ ok: false, message: err instanceof ApiError ? err.message : 'Could not save' })
    } finally {
      setBusy(false)
    }
  }

  const what = type === 'radarr' ? 'a movie folder with more than one video file' : 'the same episode (S##E##) in more than one file'

  return (
    <div className="mt-3 bg-slate-950 border border-slate-800 rounded-lg p-3 space-y-3" onClick={(e) => e.stopPropagation()}>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-0.5 accent-violet-500" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span className="text-sm text-slate-300">
          Look for duplicate files (on by default)
          <span className="block text-xs text-slate-400">
            Asks this service for every folder in its library and flags {what}. Anything found shows on the
            Dashboard and the Duplicates tab, and can alert.
          </span>
        </span>
      </label>

      {enabled && (
        <label className="block max-w-xs">
          <span className="block text-sm text-slate-400 mb-1">Scan every (minutes)</span>
          <input className="input" type="number" min={10} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
        </label>
      )}

      {enabled && (
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5 accent-violet-500" checked={cleanup} onChange={(e) => setCleanup(e.target.checked)} />
          <span className="text-sm text-slate-300">
            Show the command to delete macOS "._" files
            <span className="block text-xs text-slate-400">
              When a scan finds the hidden "._name" files a Mac leaves on a network share, the Duplicates page gets a section
              at the bottom with a command to run over SSH. It lists every file first and deletes nothing until you type yes.
            </span>
          </span>
        </label>
      )}

      {type === 'radarr' && (
        <div className="border-t border-slate-800 pt-3 space-y-3">
          <label className="block max-w-sm">
            <span className="block text-sm text-slate-300 mb-1">Deleting files Radarr hasn't indexed</span>
            <select className="input" value={method} onChange={(e) => setMethod(e.target.value as 'none' | 'mount' | 'ssh')}>
              <option value="none">Off — only files Radarr tracks can be deleted</option>
              <option value="mount">Mount — the library is mounted where Cortexarr runs</option>
              <option value="ssh">SSH — delete on the machine that holds the files</option>
            </select>
            <span className="block text-xs text-slate-400 mt-1">
              Lets the movie page's Folder contents delete extra copies, samples and sub-folders. Every delete asks you to type Delete first.
            </span>
          </label>

          {method !== 'none' && (
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-sm text-slate-400 mb-1">Library folder as Radarr sees it</span>
                <input className="input placeholder:text-slate-400" value={servicePath} placeholder="/movies" onChange={(e) => setServicePath(e.target.value)} />
              </label>
              <label className="block">
                <span className="block text-sm text-slate-400 mb-1">
                  {method === 'mount' ? 'The same folder as Cortexarr sees it' : 'The same folder on the SSH machine'}
                </span>
                <input className="input placeholder:text-slate-400" value={localPath} placeholder={method === 'mount' ? '/library/movies' : '/share/Movies'} onChange={(e) => setLocalPath(e.target.value)} />
              </label>
            </div>
          )}

          {method === 'ssh' && (
            <div className="space-y-3">
              <div className="grid sm:grid-cols-3 gap-3">
                <label className="block sm:col-span-2">
                  <span className="block text-sm text-slate-400 mb-1">SSH host</span>
                  <input className="input placeholder:text-slate-400" value={host} placeholder="nas.example.com" onChange={(e) => setHost(e.target.value)} />
                </label>
                <label className="block">
                  <span className="block text-sm text-slate-400 mb-1">Port</span>
                  <input className="input" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} />
                </label>
                <label className="block">
                  <span className="block text-sm text-slate-400 mb-1">User</span>
                  <input className="input placeholder:text-slate-400" value={user} placeholder="user" onChange={(e) => setUser(e.target.value)} />
                </label>
                <label className="block sm:col-span-2">
                  <span className="block text-sm text-slate-400 mb-1">Private key file (a path on the Cortexarr host)</span>
                  <input className="input placeholder:text-slate-400" value={keyPath} placeholder="/data/ssh/id_ed25519" onChange={(e) => setKeyPath(e.target.value)} />
                </label>
              </div>
              <label className="block">
                <span className="block text-sm text-slate-400 mb-1">Host key</span>
                <textarea
                  className="input font-mono text-xs placeholder:text-slate-400"
                  rows={2}
                  value={hostKey}
                  placeholder="nas.example.com ssh-ed25519 AAAA…"
                  onChange={(e) => setHostKey(e.target.value)}
                />
                <span className="block text-xs text-slate-400 mt-1">
                  The line printed by <code>ssh-keyscan -t ed25519 -p {port} {host || 'host'}</code>. Cortexarr only connects to a machine that presents this key. The private key itself is never stored in Cortexarr — only the path to it.
                </span>
              </label>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={save} disabled={busy} className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-1.5">
          {busy ? 'Saving…' : 'Save'}
        </button>
        {result && <span className={clsx('text-xs', result.ok ? 'text-teal-300' : 'text-red-300')}>{result.ok ? '✓ ' : '✗ '}{result.message}</span>}
      </div>
    </div>
  )
}
