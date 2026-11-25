import { logoLookup, marksFrom, type IconNode, type LogoEntry, type LogoMark } from '../../shared/motion'

/**
 * Lucide's icon shapes and Simple Icons' brand marks, loaded the first time a
 * page draws one: the editor's graphics and the export's 3D page (three-host)
 * both load them from here, so neither pulls in the other's code.
 */

let icons: Promise<(name: string) => IconNode[] | undefined> | null = null

/** Lucide's shapes, loaded the first time a graphic has an icon. */
export function loadIconNodes(): Promise<(name: string) => IconNode[] | undefined> {
  icons ??= import('lucide-static/icon-nodes.json').then((m) => {
    const nodes = m.default as unknown as Record<string, IconNode[]>
    return (name: string) => nodes[name]
  })
  return icons
}

let logos: Promise<(slug: string) => LogoMark | undefined> | null = null

/** Brand marks from Simple Icons (CC0), loaded the first time a graphic has a logo. */
export function loadLogoMarks(): Promise<(slug: string) => LogoMark | undefined> {
  logos ??= Promise.all([import('simple-icons'), import('simple-icons/icons.json')]).then(([marks, index]) =>
    logoLookup(
      ((index as { default?: unknown }).default ?? index) as LogoEntry[],
      marksFrom(marks as unknown as Record<string, unknown>)
    )
  )
  return logos
}
