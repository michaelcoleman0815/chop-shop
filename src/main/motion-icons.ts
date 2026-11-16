import type { IconNode } from '../shared/motion'

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
