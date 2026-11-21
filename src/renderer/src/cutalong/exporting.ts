/**
 * One export at a time. Export all and the editor's Export render through
 * the same progress messages, so two at once showed each other's
 * percentages on the toast and the clip cards, and rendered side by side;
 * the second now waits, and says why.
 */
export type ExportJob = { kind: 'clips' } | { kind: 'version'; n: number }

/** Why `next` cannot start while `running` does, as a sentence for the toast; null when it can. */
export function exportWait(running: ExportJob | null, next: ExportJob): string | null {
  if (!running) return null
  if (running.kind === 'clips')
    return next.kind === 'clips'
      ? "I'm still exporting the clips."
      : `I'm still exporting the clips. v${next.n} can go once they're done.`
  return `I'm still exporting v${running.n}. ${next.kind === 'clips' ? 'The clips' : `v${next.n}`} can go once that's done.`
}
