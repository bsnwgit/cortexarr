import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import MonitoredToggle from '../components/MonitoredToggle'
import ConfirmDeleteModal from '../components/ConfirmDeleteModal'
import HistoryModal from '../components/HistoryModal'
import { HistoryIcon, SearchIcon, TrashIcon } from '../components/icons/UiIcons'
import { getServiceAccent } from '../utils/serviceAccent'
import { fmtBytes, fmtDay, fmtRuntime, movieAvailability, movieStatusLabel } from '../utils/movieFormat'
import PageSpinner from '../components/PageSpinner'

interface MovieFile {
  id: number
  relative_path: string
  size: number
  quality: string
  date_added: string | null
  release_group: string
  edition: string
}

interface MovieDetailData {
  id: number
  title: string
  year: number | null
  status: string | null
  monitored: boolean
  has_file: boolean
  is_available: boolean
  size_on_disk: number
  studio: string
  runtime: number
  certification: string
  in_cinemas: string | null
  digital_release: string | null
  physical_release: string | null
  poster_url: string
  fanart_url: string
  overview: string
  genres: string[]
  imdb_rating: number | null
  tmdb_rating: number | null
  movie_file: MovieFile | null
}

interface HistoryRow {
  id: number
  event_type: string
  source_title: string | null
  quality: string
  date: string | null
}

interface SeerrMatch {
  seerr_service_id: number
  seerr_service_name: string
  request_id: number
  title: string
}

// "2026-11" for a release date — the Calendar tab's ?month= format.
function monthParam(raw: string) {
  const d = new Date(raw)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const headerButton =
  'p-2 rounded-lg border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors disabled:opacity-50'

// One movie — the Radarr counterpart of the series page. No seasons or
// episodes: the movie *is* the item, so its file and its three release
// dates sit directly on the page instead of in an accordion or calendar.
export default function MovieDetail() {
  const { id, movieId } = useParams<{ id: string; movieId: string }>()
  const navigate = useNavigate()
  const [serviceType, setServiceType] = useState('')
  const [movie, setMovie] = useState<MovieDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [monitorBusy, setMonitorBusy] = useState(false)
  const [searchBusy, setSearchBusy] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyRows, setHistoryRows] = useState<HistoryRow[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [deleteMovieOpen, setDeleteMovieOpen] = useState(false)
  const [deleteFileOpen, setDeleteFileOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [seerrMatches, setSeerrMatches] = useState<SeerrMatch[]>([])
  const [removeSeerr, setRemoveSeerr] = useState(false)
  const accent = getServiceAccent(serviceType)

  useEffect(() => {
    if (!id) return
    api.get<{ type: string }>(`/services/${id}`).then((s) => setServiceType(s.type)).catch(() => setServiceType(''))
  }, [id])

  async function loadMovie() {
    if (!id || !movieId) return
    try {
      setMovie(await api.get<MovieDetailData>(`/services/${id}/movies/${movieId}`))
      setError('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadMovie()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, movieId])

  async function toggleMonitored() {
    if (!movie) return
    const next = !movie.monitored
    setMonitorBusy(true)
    setActionError('')
    try {
      await api.patch(`/services/${id}/movies/${movieId}/monitored`, { monitored: next })
      setMovie({ ...movie, monitored: next })
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to update')
    } finally {
      setMonitorBusy(false)
    }
  }

  async function search() {
    setSearchBusy(true)
    setActionError('')
    setNotice('')
    try {
      await api.post(`/services/${id}/movies/${movieId}/search`)
      setNotice('Search sent to Radarr.')
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to trigger search')
    } finally {
      setSearchBusy(false)
    }
  }

  async function openHistory() {
    setHistoryOpen(true)
    setHistoryLoading(true)
    try {
      setHistoryRows(await api.get<HistoryRow[]>(`/services/${id}/movies/${movieId}/history`))
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to load history')
    } finally {
      setHistoryLoading(false)
    }
  }

  async function openDeleteMovie() {
    setSeerrMatches([])
    setRemoveSeerr(false)
    setDeleteMovieOpen(true)
    try {
      const matches = await api.get<SeerrMatch[]>(`/services/${id}/movies/${movieId}/seerr-requests`)
      setSeerrMatches(matches)
      setRemoveSeerr(matches.length > 0)
    } catch {
      // Coordinated delete is a bonus, not a blocker — deleting the movie
      // itself still works if this lookup fails.
    }
  }

  async function confirmDeleteMovie() {
    setDeleteBusy(true)
    try {
      await api.delete(`/services/${id}/movies/${movieId}`)
      if (removeSeerr) {
        for (const m of seerrMatches) {
          await api.post(`/services/${m.seerr_service_id}/requests/${m.request_id}/clear`, {})
        }
      }
      navigate(`/services/${id}?tab=movies`)
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to delete')
      setDeleteBusy(false)
    }
  }

  async function confirmDeleteFile() {
    if (!movie?.movie_file) return
    setDeleteBusy(true)
    try {
      await api.delete(`/services/${id}/moviefiles/${movie.movie_file.id}`)
      setDeleteFileOpen(false)
      await loadMovie()
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to delete')
    } finally {
      setDeleteBusy(false)
    }
  }

  const releaseDates: [string, string][] = []
  if (movie) {
    const candidates: [string, string | null][] = [
      ['In cinemas', movie.in_cinemas],
      ['Digital', movie.digital_release],
      ['Physical', movie.physical_release],
    ]
    for (const [label, date] of candidates) if (date) releaseDates.push([label, date])
  }

  return (
    <div>
      <div className="mb-4">
        <Link to={`/services/${id}?tab=movies`} className="text-xs text-slate-400 hover:text-slate-200">
          ← Back to Movies
        </Link>
      </div>

      {error ? (
        <p className="text-red-300 text-sm py-6 text-center">{error}</p>
      ) : loading ? (
        <PageSpinner className="py-6" />
      ) : movie ? (
        <>
          {/* Header: fanart banner + title/metadata overlay. The art sits
              behind the content rather than fixing the banner's height, so
              on a phone the banner grows to fit wrapped pills and actions
              instead of clipping the title off the top. */}
          <div className="relative rounded-xl overflow-hidden border border-slate-800 mb-4 bg-slate-925">
            {movie.fanart_url && (
              <img src={movie.fanart_url} alt="" className="absolute inset-0 w-full h-full object-cover" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/70 to-transparent" />
            <div
              className={clsx(
                'relative p-4 sm:p-5 flex flex-col sm:flex-row sm:items-end justify-between gap-3 sm:gap-4',
                movie.fanart_url ? 'pt-24 sm:pt-36' : 'pt-10',
              )}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  {movie.poster_url && (
                    <img
                      src={movie.poster_url}
                      alt=""
                      className="h-9 sm:h-11 w-6 sm:w-8 rounded object-cover shrink-0 border border-slate-700"
                    />
                  )}
                  <h2 className="text-xl sm:text-2xl font-semibold text-slate-100 truncate">{movie.title}</h2>
                </div>
                <div className="text-xs sm:text-sm text-slate-300 mt-2 flex flex-wrap gap-1.5">
                  {movie.year && <span className="metadata-pill">{movie.year}</span>}
                  <span className="metadata-pill">{movieStatusLabel(movie.status)}</span>
                  {movie.runtime > 0 && <span className="metadata-pill">{fmtRuntime(movie.runtime)}</span>}
                  {movie.certification && <span className="metadata-pill">{movie.certification}</span>}
                  {movie.studio && <span className="metadata-pill">{movie.studio}</span>}
                  {movie.imdb_rating != null && <span className="metadata-pill">IMDb {movie.imdb_rating.toFixed(1)}</span>}
                  <span className="metadata-pill">{fmtBytes(movie.size_on_disk)}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <MonitoredToggle
                  monitored={movie.monitored}
                  busy={monitorBusy}
                  accent={accent}
                  onClick={toggleMonitored}
                  variant="label"
                />
                <button onClick={search} disabled={searchBusy} title="Search for this movie" className={headerButton}>
                  <SearchIcon className="w-4 h-4" />
                </button>
                <button onClick={openHistory} title="History for this movie" className={headerButton}>
                  <HistoryIcon className="w-4 h-4" />
                </button>
                {/* Same deliberate gap as the series page — Delete shouldn't
                    sit flush against the harmless actions. */}
                <div className="w-6" />
                <button
                  onClick={openDeleteMovie}
                  title="Delete movie"
                  className="p-2 rounded-lg border border-slate-700 text-slate-400 hover:text-red-300 hover:border-red-900 hover:bg-red-950/30 transition-colors"
                >
                  <TrashIcon className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {actionError && (
            <p className="text-red-300 text-xs mb-3 bg-red-950/50 border border-red-900 rounded-lg px-3 py-2">{actionError}</p>
          )}
          {notice && (
            <p className={clsx('text-xs mb-3 border rounded-lg px-3 py-2', accent.text, accent.bg, accent.border)}>{notice}</p>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 bg-slate-925 border border-slate-800 rounded-xl p-4 space-y-3">
              {movie.overview && <p className="text-sm text-slate-300 leading-relaxed">{movie.overview}</p>}
              {movie.genres.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {movie.genres.map((g) => (
                    <span key={g} className="metadata-pill text-xs">{g}</span>
                  ))}
                </div>
              )}
              {releaseDates.length > 0 && (
                <div>
                  <h3 className="text-xs font-medium text-slate-400 mb-1.5">Release dates</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {releaseDates.map(([label, date]) => {
                      const upcoming = new Date(date).getTime() > Date.now()
                      const text = `${label} · ${fmtDay(date)}`
                      return upcoming ? (
                        <Link
                          key={label}
                          to={`/services/${id}?tab=calendar&month=${monthParam(date)}`}
                          title="View on calendar"
                          className={clsx('metadata-pill text-xs hover:underline', accent.text)}
                        >
                          {text}
                        </Link>
                      ) : (
                        <span key={label} className="metadata-pill text-xs">{text}</span>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="bg-slate-925 border border-slate-800 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-slate-100">File</h3>
                {(() => {
                  const avail = movieAvailability(movie, accent)
                  return <span className={clsx('text-xs px-2 py-0.5 rounded-lg border', avail.className)}>{avail.label}</span>
                })()}
              </div>
              {movie.movie_file ? (
                <div className="space-y-2 text-sm">
                  <p className="text-slate-100 break-all">{movie.movie_file.relative_path}</p>
                  <div className="flex flex-wrap gap-1.5 text-xs">
                    {movie.movie_file.quality && <span className="metadata-pill">{movie.movie_file.quality}</span>}
                    <span className="metadata-pill">{fmtBytes(movie.movie_file.size)}</span>
                    {movie.movie_file.release_group && <span className="metadata-pill">{movie.movie_file.release_group}</span>}
                    {movie.movie_file.edition && <span className="metadata-pill">{movie.movie_file.edition}</span>}
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-xs text-slate-400">Added {fmtDay(movie.movie_file.date_added)}</span>
                    <button
                      onClick={() => setDeleteFileOpen(true)}
                      title="Delete movie file"
                      className="p-1.5 rounded-lg border border-slate-700 text-slate-400 hover:text-red-300 hover:border-red-900 hover:bg-red-950/30 transition-colors"
                    >
                      <TrashIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-slate-400">
                    {movie.is_available ? 'Released, but no file yet.' : 'Not released yet.'}
                  </p>
                  <button onClick={search} disabled={searchBusy} className="btn-secondary flex items-center gap-1.5 disabled:opacity-50">
                    <SearchIcon className="w-3.5 h-3.5" /> {searchBusy ? 'Searching…' : 'Search'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      ) : null}

      {historyOpen && movie && (
        <HistoryModal
          title={`"${movie.title}" history`}
          rows={historyRows}
          loading={historyLoading}
          onClose={() => setHistoryOpen(false)}
          columnLabel="Release"
          columnValue={(r) => r.source_title ?? '—'}
          emptyMessage="No history for this movie."
        />
      )}

      {deleteMovieOpen && movie && (
        <ConfirmDeleteModal
          title={`Delete "${movie.title}"`}
          warning="This removes the movie from Radarr."
          busy={deleteBusy}
          onConfirm={confirmDeleteMovie}
          onCancel={() => setDeleteMovieOpen(false)}
        >
          {seerrMatches.length > 0 && (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5 accent-violet-500"
                checked={removeSeerr}
                onChange={(e) => setRemoveSeerr(e.target.checked)}
              />
              <span className="text-sm text-slate-300">
                Also remove {seerrMatches.length === 1 ? 'its Seerr request' : `its ${seerrMatches.length} Seerr requests`}
                <span className="block text-xs text-slate-400">
                  Otherwise Seerr still thinks this is wanted and may try to fill it again.
                </span>
              </span>
            </label>
          )}
        </ConfirmDeleteModal>
      )}

      {deleteFileOpen && movie?.movie_file && (
        <ConfirmDeleteModal
          title="Delete movie file"
          warning={`This deletes "${movie.movie_file.relative_path}" from disk via Radarr.`}
          busy={deleteBusy}
          onConfirm={confirmDeleteFile}
          onCancel={() => setDeleteFileOpen(false)}
        />
      )}
    </div>
  )
}
