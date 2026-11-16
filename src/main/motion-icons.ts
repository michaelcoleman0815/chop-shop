import { logoLookup, marksFrom, type IconNode, type LogoEntry, type LogoMark } from '../shared/motion'

/**
 * Lucide's icon shapes (ISC), for graphics the export draws. They are bundled
 * with the app rather than fetched, and only loaded the first time an export
 * has an icon in it.
 */

let nodes: Record<string, IconNode[]> | null = null

export async function loadIcons(): Promise<(name: string) => IconNode[] | undefined> {
  if (!nodes) {
    const mod = await import('lucide-static/icon-nodes.json')
    nodes = (mod.default ?? mod) as unknown as Record<string, IconNode[]>
  }
  const all = nodes
  return (name) => all[name]
}

let logos: ((slug: string) => LogoMark | undefined) | null = null

/**
 * Brand marks from Simple Icons (CC0), bundled with the app and loaded the
 * first time an export has a logo in it.
 */
export async function loadLogos(): Promise<(slug: string) => LogoMark | undefined> {
  if (!logos) {
    const [marks, index] = await Promise.all([import('simple-icons'), import('simple-icons/icons.json')])
    const entries = ((index as { default?: unknown }).default ?? index) as LogoEntry[]
    logos = logoLookup(entries, marksFrom(marks as unknown as Record<string, unknown>))
  }
  return logos
}
