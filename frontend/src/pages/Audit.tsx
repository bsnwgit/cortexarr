import { useEffect, useState } from 'react'
import { api } from '../api/client'
import DataTable, { type Column } from '../components/DataTable'

interface AuditEntry {
  id: number
  username: string
  action: string
  target_type: string
  target_id: string
  detail: Record<string, unknown>
  created_at: string
}

const AUDIT_COLUMNS: Column<AuditEntry>[] = [
  { key: 'created_at', label: 'Date', render: (e) => new Date(e.created_at + 'Z').toLocaleString() },
  { key: 'username', label: 'User', className: 'text-violet-300' },
  { key: 'action', label: 'Action' },
  {
    key: 'target_type',
    label: 'Target',
    render: (e) => (e.target_type ? `${e.target_type}#${e.target_id}` : '—'),
  },
]

export default function Audit() {
  const [entries, setEntries] = useState<AuditEntry[]>([])

  useEffect(() => {
    api.get<AuditEntry[]>('/audit/').then(setEntries)
  }, [])

  return (
    <DataTable
      columns={AUDIT_COLUMNS}
      rows={entries}
      rowKey={(e) => e.id}
      emptyMessage="No activity yet."
    />
  )
}
