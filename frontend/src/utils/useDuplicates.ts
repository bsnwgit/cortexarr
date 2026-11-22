import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'

export interface ScanningService {
  id: number
  name: string
  type: string
  maintenance_mode: boolean
  enabled: boolean
  scanned_at: string | null
  files_seen: number | null
  seconds: number | null
  error: string
  scanning: boolean
  // macOS "._" files the last scan came across: not duplicates, but worth cleaning up.
  junk: { count: number; roots: Record<string, number>; samples: string[] } | null
}

export interface DuplicateFinding {
  service_id: number
  service_name: string
  service_type: string
  key: string
  kind: 'movie' | 'series'
  title: string
  reason: string
  files: string[]
  deletable: boolean
  first_seen: string
  // The series / movie in the service itself, when it could be matched.
  target_id: number | null
  // The series / movie folder, what each file weighs and when it last changed, and the copy
  // "delete all extras" keeps (the newest; null when that can't be decided).
  folder: string
  info: Record<string, { size: number | null; modified: string | null }>
  keep: string | null
}

export interface DuplicatesData {
  services: ScanningService[]
  findings: DuplicateFinding[]
  counts: Record<number, number>
}

const EMPTY: DuplicatesData = { services: [], findings: [], counts: {} }

// What each service's duplicate scan has found. Used by the nav (the
// Duplicates tab only exists while there is something to show), the
// Dashboard's per-service pills, and the Duplicates page itself.
// `fast` re-reads every few seconds — for the page, while a scan runs.
export function useDuplicates(fast = false) {
  const [data, setData] = useState<DuplicatesData>(EMPTY)
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await api.get<DuplicatesData>('/duplicates/'))
    } catch {
      // Not signed in yet, or the server is restarting: keep what we had.
    } finally {
      setLoaded(true)
    }
  }, [])

  const scanning = data.services.some((s) => s.scanning)
  useEffect(() => {
    load()
    const interval = setInterval(load, fast && scanning ? 4000 : 30000)
    return () => clearInterval(interval)
  }, [load, fast, scanning])

  return { data, loaded, reload: load, total: data.findings.length }
}
