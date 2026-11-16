/**
 * Node's path module for the phone build, POSIX only: iPhone and Android
 * paths are POSIX. The shared main-process modules join and split paths with
 * it; vite.config.ts points 'path' here. path.test.ts holds it to Node's.
 */

function normalizeParts(parts: string[], absolute: boolean): string[] {
  const out: string[] = []
  for (const p of parts) {
    if (!p || p === '.') continue
    if (p === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(p)
  }
  return out
}

export function normalize(path: string): string {
  if (path === '') return '.'
  const absolute = path.startsWith('/')
  const trailing = path.endsWith('/')
  const joined = normalizeParts(path.split('/'), absolute).join('/')
  if (!joined) return absolute ? '/' : '.'
  return `${absolute ? '/' : ''}${joined}${trailing ? '/' : ''}`
}

export function join(...parts: string[]): string {
  const kept = parts.filter((p) => p !== '')
  return kept.length === 0 ? '.' : normalize(kept.join('/'))
}

export function resolve(...parts: string[]): string {
  let out = ''
  for (let i = parts.length - 1; i >= 0 && !out.startsWith('/'); i--) {
    if (parts[i]) out = out ? `${parts[i]}/${out}` : parts[i]
  }
  if (!out.startsWith('/')) out = `/${out}`
  const n = normalize(out)
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n
}

function trimEnd(path: string): string {
  let end = path.length
  while (end > 1 && path[end - 1] === '/') end--
  return path.slice(0, end)
}

export function basename(path: string, ext?: string): string {
  const trimmed = trimEnd(path)
  const base = trimmed === '/' ? '' : trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return ext && base !== ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base
}

export function dirname(path: string): string {
  if (path === '') return '.'
  const trimmed = trimEnd(path)
  const at = trimmed.lastIndexOf('/')
  if (at < 0) return '.'
  if (at === 0) return '/'
  return trimEnd(trimmed.slice(0, at))
}

export function extname(path: string): string {
  const base = basename(path)
  const at = base.lastIndexOf('.')
  return at <= 0 ? '' : base.slice(at)
}

export function isAbsolute(path: string): boolean {
  return path.startsWith('/')
}

export function relative(from: string, to: string): string {
  const a = resolve(from).split('/').filter(Boolean)
  const b = resolve(to).split('/').filter(Boolean)
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/')
}

export const sep = '/'
export const delimiter = ':'

const path = { normalize, join, resolve, basename, dirname, extname, isAbsolute, relative, sep, delimiter }
export const posix = path
export default path
