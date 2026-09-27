import { fmtDateTime } from '../utils/time'
interface HistoryRow {
  id: number
  event_type: string
  episode?: string
  source_title: string | null
  quality: string
  date: string | null
}

function fmtDate(v: string | null) {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? v : fmtDateTime(d)
}

// The third column defaults to the episode (series/season history); a
// movie's history has no episodes, so it shows the release name instead.
export default function HistoryModal({
  title, rows, loading, onClose,
  columnLabel = 'Episode',
  columnValue = (r) => r.episode ?? '',
  emptyMessage = 'No history for this season.',
}: {
  title: string
  rows: HistoryRow[]
  loading: boolean
  onClose: () => void
  columnLabel?: string
  columnValue?: (row: HistoryRow) => string
  emptyMessage?: string
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
      <div className="w-full max-w-2xl max-h-[80vh] flex flex-col bg-slate-925 border border-slate-800 rounded-xl shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <h3 className="text-base font-semibold text-slate-100">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200 text-sm">
            Close
          </button>
        </div>
        <div className="overflow-y-auto p-4">
          {loading ? (
            <p className="text-slate-500 text-sm py-6 text-center">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-slate-500 text-sm py-6 text-center">{emptyMessage}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-400 border-b border-slate-800">
                  <th className="font-medium py-2 pr-3">Date</th>
                  <th className="font-medium py-2 pr-3">Event</th>
                  <th className="font-medium py-2 pr-3">{columnLabel}</th>
                  <th className="font-medium py-2 pr-3">Quality</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-900 last:border-0">
                    <td className="py-2 pr-3 text-slate-100 whitespace-nowrap">{fmtDate(r.date)}</td>
                    <td className="py-2 pr-3 text-slate-100 capitalize">{r.event_type}</td>
                    <td className="py-2 pr-3 text-slate-100">{columnValue(r)}</td>
                    <td className="py-2 pr-3 text-slate-100">{r.quality || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
