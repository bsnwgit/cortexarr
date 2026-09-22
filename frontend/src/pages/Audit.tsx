import { useEffect, useState } from 'react'
import { api } from '../api/client'

interface AuditEntry {
  id: number
  username: string
  action: string
  target_type: string
  target_id: string
  detail: Record<string, unknown>
  created_at: string
}

export default function Audit() {
  const [entries, setEntries] = useState<AuditEntry[]>([])

  useEffect(() => {
    api.get<AuditEntry[]>('/audit/').then(setEntries)
  }, [])

  return (
    <div>
      <h2 className="text-lg font-semibold text-slate-100 mb-4">Audit log</h2>
      <div className="space-y-1">
        {entries.map((e) => (
          <div key={e.id} className="bg-slate-925 border border-slate-800 rounded-lg px-4 py-2 text-sm flex flex-col sm:flex-row sm:justify-between gap-1">
            <span className="text-slate-200">
              <span className="text-violet-300">{e.username}</span> · {e.action}
              {e.target_type && <span className="text-slate-500"> · {e.target_type}#{e.target_id}</span>}
            </span>
            <span className="text-slate-500 text-xs">{new Date(e.created_at + 'Z').toLocaleString()}</span>
          </div>
        ))}
        {entries.length === 0 && <p className="text-slate-500 text-sm">No activity yet.</p>}
      </div>
    </div>
  )
}
