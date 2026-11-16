import type { MotionRow } from './schema'

/**
 * A graphic's rows as lines a person can edit: "label: value", a note after
 * a bar, and + for a pro, - for a con, * for the row to pick out.
 */

const MARKS: Record<string, string> = { pro: '+ ', con: '- ', hi: '* ' }

/** Rows as lines: "label: value", with + for a pro, - for a con and * to highlight one. */
export function rowsToText(rows: MotionRow[]): string {
  return rows
    .map((r) => {
      const head = `${MARKS[r.mark] ?? ''}${r.label}`
      const value = r.value ? `: ${r.value}` : ''
      const note = r.note ? ` | ${r.note}` : ''
      return `${head}${value}${note}`
    })
    .join('\n')
}

/** Lines back into rows. Each row keeps the moment of the row it replaces, by position. */
export function textToRows(text: string, previous: MotionRow[]): MotionRow[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((line, i) => {
      const mark = line.startsWith('+') ? 'pro' : line.startsWith('- ') ? 'con' : line.startsWith('*') ? 'hi' : ''
      const body = mark ? line.slice(1).trim() : line
      const [main, note = ''] = body.split(/\s*\|\s*/)
      const at = main.indexOf(':')
      const labelText = at >= 0 ? main.slice(0, at).trim() : main.trim()
      const value = at >= 0 ? main.slice(at + 1).trim() : ''
      const keep = previous[i]?.at ?? ''
      return { label: labelText, value, note: note.trim(), mark, at: keep }
    })
}
