import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import type { ServiceAccent } from '../utils/serviceAccent'
import { fmtBytes, fmtDuration, fmtSpeed } from '../utils/downloadFormat'

export interface DownloadOverviewData {
  download_rate: number
  download_limit: number
  remaining_bytes: number
  eta_seconds: number | null
  free_disk_bytes: number
  total_disk_bytes: number
  paused: boolean
  post_jobs: number
  quota_reached: boolean
}

// The strip above a download client's tabs: speed, what's left, disk, and the global
// Pause/Resume for all downloading.
export default function DownloadOverview({ serviceId, accent }: { serviceId: string; accent: ServiceAccent }) {
  const [data, setData] = useState<DownloadOverviewData | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    try {
      setData(await api.get<DownloadOverviewData>(`/services/${serviceId}/detail/overview`))
      setError('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load')
    }
  }

  useEffect(() => {
    load()
    const interval = setInterval(load, 5000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId])

  async function toggle() {
    if (!data) return
    setBusy(true)
    try {
      await api.post(`/services/${serviceId}/download-control/${data.paused ? 'resume' : 'pause'}`)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update')
    } finally {
      setBusy(false)
    }
  }

  if (error && !data) return <p className="text-red-300 text-sm mb-4">{error}</p>
  if (!data) return null

  const usedPct = data.total_disk_bytes ? Math.round((1 - data.free_disk_bytes / data.total_disk_bytes) * 100) : null

  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      <span className={clsx('metadata-pill text-xs', data.paused ? 'text-amber-300' : accent.text)}>
        {data.paused ? 'Paused' : `↓ ${fmtSpeed(data.download_rate)}`}
        {data.download_limit ? ` (limit ${fmtSpeed(data.download_limit)})` : ''}
      </span>
      <span className="metadata-pill text-xs">
        {fmtBytes(data.remaining_bytes)} left{data.eta_seconds != null ? ` · ${fmtDuration(data.eta_seconds)}` : ''}
      </span>
      <span className="metadata-pill text-xs">
        {fmtBytes(data.free_disk_bytes)} free{usedPct != null ? ` · ${usedPct}% used` : ''}
      </span>
      {data.post_jobs > 0 && <span className="metadata-pill text-xs">{data.post_jobs} post-processing</span>}
      {data.quota_reached && <span className="metadata-pill text-xs text-amber-300">Quota reached</span>}
      <button
        onClick={toggle}
        disabled={busy}
        className={clsx(
          'text-xs px-2.5 py-1 rounded-lg border transition-colors disabled:opacity-50',
          data.paused
            ? clsx(accent.border, accent.text, 'hover:bg-slate-900')
            : 'border-amber-600/40 text-amber-300 hover:bg-amber-600/10',
        )}
      >
        {busy ? '…' : data.paused ? 'Resume all' : 'Pause all'}
      </button>
    </div>
  )
}
