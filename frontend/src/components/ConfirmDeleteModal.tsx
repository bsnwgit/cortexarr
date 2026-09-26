import { useState } from 'react'

// Requires typing the literal word "Delete" before the confirm button
// enables — used for every destructive action here (series delete, episode
// file delete). The action itself can't be undone from Cortexarr; this is
// the one guard against a stray click.
export default function ConfirmDeleteModal({
  title, warning, confirmLabel = 'Delete', busy, onConfirm, onCancel,
}: {
  title: string
  warning: string
  confirmLabel?: string
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const [typed, setTyped] = useState('')
  const canConfirm = typed === 'Delete' && !busy

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
      <div className="w-full max-w-sm bg-slate-925 border border-slate-800 rounded-xl p-6 shadow-xl">
        <h3 className="text-base font-semibold text-slate-100 mb-2">{title}</h3>
        <p className="text-sm text-red-300 bg-red-950/50 border border-red-900 rounded-lg px-3 py-2 mb-4">
          {warning} This can't be undone.
        </p>
        <label className="block text-xs text-slate-400 mb-1">
          Type <span className="font-semibold text-slate-200">Delete</span> to confirm
        </label>
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="input w-full mb-4"
          placeholder="Delete"
        />
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} disabled={busy} className="btn-secondary">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm}
            className="rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:hover:bg-red-600 text-white text-sm font-medium px-4 py-2"
          >
            {busy ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
