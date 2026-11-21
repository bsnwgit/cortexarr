import type { MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'

// Sits beside a service's status pill on its Dashboard card, and only exists
// while that service's scan has found duplicates. Opens the Duplicates page
// narrowed to this service.
export default function DuplicatePill({ count, serviceId }: { count?: number; serviceId: number }) {
  const navigate = useNavigate()
  if (!count) return null
  function open(e: MouseEvent) {
    e.stopPropagation()
    navigate(`/duplicates?service=${serviceId}`)
  }
  return (
    <button
      type="button"
      onClick={open}
      title="Show the duplicate files"
      className="text-xs px-2 py-1 rounded-lg border bg-amber-500/15 text-amber-300 border-amber-500/30 hover:bg-amber-500/25"
    >
      {count} duplicate{count === 1 ? '' : 's'}
    </button>
  )
}
