/** The IPC handlers the stubbed Electron kept, called as the renderer would call them. */
export type Handler = (e: unknown, ...args: unknown[]) => Promise<unknown>

export function handler(channel: string): Handler {
  const handlers = (globalThis as unknown as { __labHandlers?: Map<string, Handler> }).__labHandlers
  const fn = handlers?.get(channel)
  if (!fn) throw new Error(`No handler for ${channel}: run this through scripts/lab.mjs, which stubs Electron.`)
  return fn
}

/** Progress as the chat would show it, one line per new stage, to stderr. */
export function progressLogger(): (stage: string, percent?: number | null) => void {
  const t0 = Date.now()
  let last = ''
  return (stage, percent) => {
    const line = percent === undefined || percent === null ? stage : `${stage} ${Math.floor(percent / 10) * 10}%`
    if (line === last) return
    last = line
    process.stderr.write(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${line}\n`)
  }
}

export function fail(err: unknown): never {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
}
