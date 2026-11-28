import { useEffect, useState } from 'react'
import { api, ApiError } from '../api/client'
import PageSpinner from './PageSpinner'

interface Worker { name: string; heat_problem: string | null; seconds_since_seen: number }
interface Status {
  version: string
  setup_complete: boolean
  jobs: Record<string, number>
  paused: string | null
  workers: Worker[]
}

const COUNTS = [
  ['queued', 'Waiting'],
  ['running', 'Running'],
  ['done', 'Done'],
  ['failed', 'Failed'],
] as const

function ago(seconds: number) {
  if (seconds < 90) return `${seconds}s ago`
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`
  return `${Math.round(seconds / 3600)} h ago`
}

// ReelHound's indexing status, read-only: job counts, any pause, and each worker's health.
export default function ReelhoundStatus({ serviceId }: { serviceId: string }) {
  const [data, setData] = useState<Status | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = () =>
      api
        .get<Status>(`/services/${serviceId}/detail/overview`)
        .then((d) => { if (!cancelled) { setData(d); setError('') } })
        .catch((err) => { if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load') })
    load()
    const interval = setInterval(load, 15000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [serviceId])

  if (error && !data) return <p className="text-red-300 text-sm py-6 text-center">{error}</p>
  if (!data) return <PageSpinner className="py-6" />

  return (
    <div className="space-y-3">
      {error && <p className="text-red-300 text-sm">{error}</p>}
      <section className="bg-slate-925 border border-slate-800 rounded-xl p-4 space-y-3" aria-label="Indexing">
        <h3 className="font-medium text-slate-100">Indexing jobs</h3>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {COUNTS.map(([key, label]) => (
            <div key={key}>
              <dt className="text-xs text-slate-400">{label}</dt>
              <dd className={key === 'failed' && data.jobs.failed ? 'text-xl text-red-300' : 'text-xl text-slate-100'}>
                {(data.jobs[key] ?? 0).toLocaleString()}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-sm text-slate-100">{data.paused ? `Paused: ${data.paused}.` : 'Not paused.'}</p>
        {!data.setup_complete && <p className="text-sm text-amber-300">ReelHound's first-time setup is not finished.</p>}
        <p className="text-xs text-slate-400">ReelHound {data.version}</p>
      </section>
      <section className="bg-slate-925 border border-slate-800 rounded-xl p-4 space-y-2" aria-label="Workers">
        <h3 className="font-medium text-slate-100">Workers</h3>
        {data.workers.length === 0 ? (
          <p className="text-sm text-slate-400">No worker has reported since ReelHound started.</p>
        ) : (
          <ul className="space-y-1">
            {data.workers.map((w) => (
              <li key={w.name} className="text-sm text-slate-100">
                {w.name} <span className="text-slate-400">· last asked for work {ago(w.seconds_since_seen)}</span>
                <span className={w.heat_problem ? 'block text-amber-300' : 'block text-slate-400'}>
                  {w.heat_problem ?? 'No heat problem reported.'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
