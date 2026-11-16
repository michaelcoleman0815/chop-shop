import { createReadStream, promises as fs } from 'fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { extname } from 'path'
import { pathToFileURL } from 'url'

/**
 * Serves the person's own files to the window, so a recording plays, seeks
 * and scrubs the way a video on a website does.
 *
 * A custom protocol is not enough for video: Chromium's player asks for byte
 * ranges as it reads and seeks, and it does not resume ranges answered
 * through Electron's protocol bridge. A clip past half a megabyte stalled,
 * and a long one whose index sits at the end of the file never started.
 * Plain HTTP is what the player is built for.
 *
 * Only this computer can reach it (127.0.0.1), and only with the token made
 * at launch, which never leaves the app.
 */

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  // QuickTime is the MP4 family; Chromium's player reads it by its contents.
  '.mov': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml'
}

export interface MediaServer {
  /** http://127.0.0.1:port/token, with no trailing slash. */
  base: string
  close: () => Promise<void>
}

let running: MediaServer | null = null

/** The address files are served from, or '' when the server could not start. */
export function mediaBase(): string {
  return running?.base ?? ''
}

/**
 * A local file as the window can load it. Should the server ever fail to
 * start, a file URL still plays in the packaged app, whose page is a file too.
 */
export function mediaUrl(path: string): string {
  return running ? `${running.base}/${encodeURIComponent(path)}` : pathToFileURL(path).toString()
}

export async function startMediaServer(): Promise<MediaServer> {
  if (running) return running
  const token = randomBytes(16).toString('hex')
  const server: Server = createServer((req, res) => void answer(req, res, token))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  running = {
    base: `http://127.0.0.1:${port}/${token}`,
    close: () =>
      new Promise<void>((resolve) => {
        running = null
        server.close(() => resolve())
        server.closeAllConnections()
      })
  }
  return running
}

/** A byte range from a Range header, clamped to the file; null when there is none to give. */
export function parseRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | 'invalid' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid'
  if (m[1] === '') {
    // The last n bytes.
    const n = Number(m[2])
    if (n === 0) return 'invalid'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(m[1])
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  if (start >= size || end < start) return 'invalid'
  return { start, end }
}

async function answer(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const slash = url.pathname.indexOf('/', 1)
  if (slash < 0 || url.pathname.slice(1, slash) !== token) {
    res.writeHead(403).end()
    return
  }
  let path: string
  try {
    path = decodeURIComponent(url.pathname.slice(slash + 1))
  } catch {
    res.writeHead(400).end()
    return
  }
  let size: number
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile()) throw new Error('not a file')
    size = stat.size
  } catch {
    console.error('[media] 404', path)
    res.writeHead(404).end()
    return
  }
  const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
  const range = parseRange(req.headers.range, size)
  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
    return
  }
  const { start, end } = range ?? { start: 0, end: size - 1 }
  res.writeHead(range ? 206 : 200, {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Content-Length': String(size === 0 ? 0 : end - start + 1),
    'Cache-Control': 'no-cache',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
  })
  if (req.method === 'HEAD' || size === 0) {
    res.end()
    return
  }
  const stream = createReadStream(path, { start, end })
  // The player drops a range whenever it seeks; that is routine, not an error.
  res.on('close', () => stream.destroy())
  stream.on('error', (err) => {
    console.error('[media] read error', err.message, path)
    res.destroy()
  })
  stream.pipe(res)
}
