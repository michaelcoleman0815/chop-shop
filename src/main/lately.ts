import { promises as fs } from 'fs'
import { dirname } from 'path'
import { z } from 'zod'
import { currentCut, type EditDoc, type Op } from '../shared/edit'

/**
 * What the last few edits looked like, so the next one is not the same again: the graphics each planned edit added
 * and the art direction it wore, a line an edit, the newest first.
 */

const KEEP = 6
const LatelySchema = z.array(z.object({ doc: z.string(), line: z.string().max(400) })).max(20)

/** One planned edit in a line: its graphics by kind and style, and its look; null when it adds none. */
export function latelyLine(doc: EditDoc, ops: Op[]): string | null {
  const count = new Map<string, number>()
  for (const o of ops)
    if (o.op === 'motion-add') {
      const what = `${o.kind}${o.style ? ` ${o.style}` : ''}`
      count.set(what, (count.get(what) ?? 0) + 1)
    }
  if (count.size === 0) return null
  const set = ops.filter((o) => o.op === 'direction').at(-1)
  const look = { ...currentCut(doc).direction, ...(set?.op === 'direction' ? set.set : {}) }
  const graphics = [...count].map(([k, n]) => (n > 1 ? `${k} x${n}` : k)).join(', ')
  const worn = [look.accent, look.display, look.ground ? `${look.ground} ground` : '', look.idea].filter(Boolean).join(', ')
  return `${graphics}${worn ? `; ${worn}` : '; the house look'}`.slice(0, 400)
}

async function readAll(path: string): Promise<z.infer<typeof LatelySchema>> {
  const raw = await fs.readFile(path, 'utf8').then((t) => JSON.parse(t) as unknown, () => null)
  const read = LatelySchema.safeParse(raw)
  return read.success ? read.data : []
}

/** The last edits' lines, but this one's own. */
export async function lately(path: string, doc: string): Promise<string[]> {
  return (await readAll(path)).filter((e) => e.doc !== doc).map((e) => e.line)
}

/** Remembers a planned edit, in place of what was remembered of it before. */
export async function remember(path: string, doc: EditDoc, ops: Op[]): Promise<void> {
  const line = latelyLine(doc, ops)
  if (!line) return
  const all = [{ doc: doc.id, line }, ...(await readAll(path)).filter((e) => e.doc !== doc.id)].slice(0, KEEP)
  await fs.mkdir(dirname(path), { recursive: true }).catch(() => undefined)
  await fs.writeFile(`${path}.part`, JSON.stringify(all)).then(() => fs.rename(`${path}.part`, path)).catch(() => undefined)
}
