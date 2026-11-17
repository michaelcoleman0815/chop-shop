import { promises as fs, type Dirent } from 'fs'
import { join, relative, sep } from 'path'
import { classify, extOf, PACKAGE_DIRS, SKIP_DIRS, UNSUPPORTED, type FileClass } from '../../../shared/broll/files'

/**
 * The person's folder, walked a directory at a time and handed on as it
 * goes, so a Documents folder of a hundred thousand files never sits in
 * memory whole. Only the files worth indexing are looked at closely (one
 * stat each); the rest are counted. Hidden folders, caches and the
 * packages apps keep their own libraries in are not walked into. A link to
 * a folder is followed once, and a link back to a folder already walked is
 * noticed and left. A folder that cannot be read is noted and skipped.
 */

export interface WalkedFile {
  path: string
  /** Below the walk's root, for tags. */
  rel: string
  name: string
  cls: Exclude<FileClass, { is: 'other' }>
  size: number
  mtimeMs: number
  /** The file itself, wherever links lead: the same file reached twice is indexed once. */
  id: string
}

export interface WalkReport {
  dirs: number
  files: number
  /** Files of no use to an edit: documents, archives, code. */
  ignored: number
  linksFollowed: number
  /** Links back into the folder itself, or round in a circle: what they lead to is walked where it is. */
  linkLoops: number
  brokenLinks: number
  /** Folders that could not be read, a few named. */
  unreadable: number
  unreadableExamples: string[]
  /** App packages and libraries not walked into, by what they are. */
  packages: { path: string; ext: string }[]
}

export function emptyReport(): WalkReport {
  return {
    dirs: 0,
    files: 0,
    ignored: 0,
    linksFollowed: 0,
    linkLoops: 0,
    brokenLinks: 0,
    unreadable: 0,
    unreadableExamples: [],
    packages: []
  }
}

/** A directory's files are done: what the indexer groups by folder (image sequences) can be settled. */
export interface DirDone {
  done: string
}

const STAT_BATCH = 32

export async function* walk(
  root: string,
  opts: { report: WalkReport; signal?: AbortSignal; maxDepth?: number }
): AsyncGenerator<WalkedFile | DirDone> {
  const maxDepth = opts.maxDepth ?? 40
  const seenDirs = new Set<string>()
  const seenFiles = new Set<string>()
  const top = await fs.stat(root)
  seenDirs.add(`${top.dev}:${top.ino}`)
  const real = await fs.realpath(root)
  /** A link that leads back inside the folder: what it leads to is walked where it really is, under its own folders' words. */
  const inside = async (path: string): Promise<boolean> => {
    try {
      const target = await fs.realpath(path)
      return target === real || target.startsWith(real.endsWith(sep) ? real : `${real}${sep}`)
    } catch {
      return false
    }
  }
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  while (stack.length) {
    if (opts.signal?.aborted) return
    const { dir, depth } = stack.pop() as { dir: string; depth: number }
    let handle: Awaited<ReturnType<typeof fs.opendir>>
    try {
      handle = await fs.opendir(dir, { bufferSize: 128 })
    } catch {
      opts.report.unreadable++
      if (opts.report.unreadableExamples.length < 5) opts.report.unreadableExamples.push(dir)
      continue
    }
    opts.report.dirs++
    const wanted: { name: string; link: boolean; cls: WalkedFile['cls'] }[] = []
    const subdirs: string[] = []
    try {
      for await (const e of handle as AsyncIterable<Dirent>) {
        const name = e.name
        if (name.startsWith('.')) continue
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(name)) continue
          if (PACKAGE_DIRS.test(name)) {
            const ext = extOf(name)
            if (UNSUPPORTED[ext]) opts.report.packages.push({ path: join(dir, name), ext })
            continue
          }
          subdirs.push(name)
          continue
        }
        const link = e.isSymbolicLink()
        if (!link && !e.isFile()) continue
        const cls = classify(name)
        if (cls.is === 'other') {
          // A link to a folder classifies as nothing by its name; it is looked at below.
          if (link) wanted.push({ name, link, cls: { is: 'json' } })
          else {
            opts.report.files++
            opts.report.ignored++
          }
          continue
        }
        wanted.push({ name, link, cls })
      }
    } catch {
      opts.report.unreadable++
      if (opts.report.unreadableExamples.length < 5) opts.report.unreadableExamples.push(dir)
    }

    for (let i = 0; i < wanted.length; i += STAT_BATCH) {
      const batch = wanted.slice(i, i + STAT_BATCH)
      const stats = await Promise.all(
        batch.map(async (w) => {
          try {
            return await fs.stat(join(dir, w.name))
          } catch {
            return null
          }
        })
      )
      for (const [j, w] of batch.entries()) {
        const s = stats[j]
        const path = join(dir, w.name)
        if (!s) {
          if (w.link) opts.report.brokenLinks++
          continue
        }
        if (s.isDirectory()) {
          // Only links reach here as folders.
          const key = `${s.dev}:${s.ino}`
          if (seenDirs.has(key) || depth + 1 > maxDepth || (await inside(path))) opts.report.linkLoops++
          else if (PACKAGE_DIRS.test(w.name) || SKIP_DIRS.has(w.name)) continue
          else {
            seenDirs.add(key)
            opts.report.linksFollowed++
            stack.push({ dir: path, depth: depth + 1 })
          }
          continue
        }
        if (!s.isFile()) continue
        const cls = w.link ? classify(w.name) : w.cls
        opts.report.files++
        if (w.link && (await inside(path))) {
          // The file it leads to is in the folder, and is indexed there.
          opts.report.linkLoops++
          continue
        }
        if (cls.is === 'other') {
          opts.report.ignored++
          continue
        }
        const id = `${s.dev}:${s.ino}`
        if (seenFiles.has(id)) continue
        seenFiles.add(id)
        if (w.link) opts.report.linksFollowed++
        yield { path, rel: relative(root, path), name: w.name, cls, size: s.size, mtimeMs: Math.round(s.mtimeMs), id }
      }
    }
    yield { done: dir }

    // Folders are walked in name order, the first on top of the stack.
    for (const name of subdirs.sort().reverse()) {
      const path = join(dir, name)
      if (depth + 1 > maxDepth) continue
      let key: string | null = null
      try {
        const s = await fs.stat(path)
        key = `${s.dev}:${s.ino}`
      } catch {
        opts.report.unreadable++
        continue
      }
      if (seenDirs.has(key)) {
        opts.report.linkLoops++
        continue
      }
      seenDirs.add(key)
      stack.push({ dir: path, depth: depth + 1 })
    }
  }
}
