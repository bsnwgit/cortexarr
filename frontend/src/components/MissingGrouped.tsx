import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError } from '../api/client'
import MonitoredToggle from './MonitoredToggle'
import type { ServiceAccent } from '../utils/serviceAccent'
import { fmtDateOnly } from '../utils/time'
import PageSpinner from './PageSpinner'

interface WantedItem {
  id: number
  series: string
  series_id: number | null
  season_number: number | null
  episode: string
  air_date: string | null
  monitored: boolean
}

function seriesLink(serviceId: string, item: WantedItem): string | null {
  if (item.series_id == null) return null
  const seasonQuery = item.season_number != null ? `?season=${item.season_number}` : ''
  return `/services/${serviceId}/series/${item.series_id}${seasonQuery}`
}

function fmtDate(v: string | null) {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? v : fmtDateOnly(d)
}

// All missing episodes, grouped by series — the "Missing" tab. Distinct
// from Downloading > Missing (a flat list): this one is organized the way
// you'd actually scan it, by show, for a pipeline that's missing episodes
// across many series at once.
export default function MissingGrouped({ serviceId, accent }: { serviceId: string; accent: ServiceAccent }) {
  const navigate = useNavigate()
  const [rows, setRows] = useState<WantedItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set())
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError('')
      try {
        const data = await api.get<WantedItem[]>(`/services/${serviceId}/detail/wanted`)
        if (!cancelled) setRows(data)
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const interval = setInterval(load, 20000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [serviceId])

  async function toggleMonitored(row: WantedItem) {
    setBusyIds((b) => new Set(b).add(row.id))
    setActionError('')
    const nextMonitored = !row.monitored
    try {
      await api.patch(`/services/${serviceId}/episodes/${row.id}/monitored`, { monitored: nextMonitored })
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, monitored: nextMonitored } : r)))
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to update')
    } finally {
      setBusyIds((b) => {
        const n = new Set(b)
        n.delete(row.id)
        return n
      })
    }
  }

  const grouped = useMemo(() => {
    const bySeries = new Map<string, WantedItem[]>()
    for (const row of rows) {
      const list = bySeries.get(row.series) ?? []
      list.push(row)
      bySeries.set(row.series, list)
    }
    return Array.from(bySeries.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [rows])

  return (
    <div className="bg-slate-925 border border-slate-800 rounded-xl p-2 sm:p-4">
      {error ? (
        <p className="text-red-300 text-sm py-6 text-center">{error}</p>
      ) : loading && rows.length === 0 ? (
        <PageSpinner className="py-6" />
      ) : grouped.length === 0 ? (
        <p className="text-slate-500 text-sm py-6 text-center">No missing episodes.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {actionError && <p className="text-red-300 text-xs">{actionError}</p>}
          {grouped.map(([series, episodes]) => {
            const seriesId = episodes[0]?.series_id
            return (
            <div key={series}>
              <h3 className="text-sm font-medium text-slate-100 mb-2">
                {seriesId != null ? (
                  <button
                    onClick={() => navigate(`/services/${serviceId}/series/${seriesId}`)}
                    className="hover:underline"
                  >
                    {series}
                  </button>
                ) : (
                  series
                )}{' '}
                <span className="text-slate-500 font-normal">({episodes.length})</span>
              </h3>
              <div className="overflow-x-auto -mx-2 sm:mx-0">
                <table className="w-full text-sm min-w-[480px] sm:min-w-0">
                  <thead>
                    <tr className="text-left text-slate-400 border-b border-slate-800">
                      <th className="font-medium py-2 px-3">Episode</th>
                      <th className="font-medium py-2 px-3">Air date</th>
                      <th className="font-medium py-2 px-3">Monitored</th>
                    </tr>
                  </thead>
                  <tbody>
                    {episodes.map((ep) => {
                      const link = seriesLink(serviceId, ep)
                      return (
                      <tr key={ep.id} className="border-b border-slate-900 last:border-0 hover:bg-slate-900/40">
                        <td className="py-2 px-3 text-slate-100">
                          {link ? (
                            <button onClick={() => navigate(link)} className="hover:underline">
                              {ep.episode}
                            </button>
                          ) : (
                            ep.episode
                          )}
                        </td>
                        <td className="py-2 px-3 text-slate-100">{fmtDate(ep.air_date)}</td>
                        <td className="py-2 px-3">
                          <MonitoredToggle
                            monitored={ep.monitored}
                            busy={busyIds.has(ep.id)}
                            accent={accent}
                            onClick={() => toggleMonitored(ep)}
                          />
                        </td>
                      </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
