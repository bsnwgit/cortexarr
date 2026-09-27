import type { ReactNode } from 'react'

// A labelled field, shared by the Settings tabs (General, Notifications).
export default function SettingsRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm text-slate-400 mb-1">{label}</span>
      {children}
    </label>
  )
}
