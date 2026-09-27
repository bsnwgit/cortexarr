// A notification send's result, as a person would say it: a tick when it
// went, "Not sent" when the channel isn't ready, a cross when it failed.
export function resultText(r: { status: string; detail: string }) {
  if (r.status === 'sent') return `✓ ${r.detail}`
  if (r.status === 'skipped') return `Not sent: ${r.detail}`
  if (r.status === 'queued') return `Queued: ${r.detail}`
  return `✗ ${r.detail}`
}
