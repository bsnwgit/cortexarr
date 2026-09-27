// Request states as seerr_client.py reports them, with their labels and
// colors — shared by the Requests tab and the dashboard card.
import type { ServiceAccent } from './serviceAccent'
import { fmtDateTime } from './time'

export type RequestState = 'pending' | 'approved' | 'declined' | 'failed' | 'processing' | 'partial' | 'available'

export const REQUEST_STATE_LABELS: Record<RequestState, string> = {
  pending: 'Pending approval',
  approved: 'Approved',
  processing: 'Processing',
  partial: 'Partially available',
  available: 'Available',
  failed: 'Failed',
  declined: 'Declined',
}

// Needs-a-person states stand out (amber/red); settled ones read in the
// service's own accent; declined is neutral.
export function requestStateClass(state: RequestState, accent: ServiceAccent): string {
  if (state === 'pending') return 'text-amber-300 border-amber-600/40 bg-amber-600/10'
  if (state === 'failed') return 'text-red-300 border-red-600/40 bg-red-600/10'
  if (state === 'declined') return 'text-slate-300 border-slate-700'
  return `${accent.text} ${accent.border} ${accent.bg}`
}

export function fmtWhen(v: string | null) {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? v : fmtDateTime(d)
}
