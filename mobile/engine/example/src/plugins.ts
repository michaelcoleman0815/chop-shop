import { registerPlugin } from '@capacitor/core'
import type { EngineLine, EnginePlugin, EngineRunResult, EngineTool } from 'cutalong-engine'

/** The plugin under test, registered by name as the app registers it. */
export const Engine = registerPlugin<EnginePlugin>('CutalongEngine')

/**
 * What only this test app has: its launch flags, its bundled media as files,
 * reading and writing small text files, the process's memory, and the
 * plugin's native copy-in and save-to-gallery code without their pickers.
 */
export interface SelfTestHostPlugin {
  launch(): Promise<{ selftest: boolean }>
  prepareMedia(): Promise<{ dir: string }>
  readText(options: { path: string }): Promise<{ text: string }>
  writeText(options: { path: string; text: string }): Promise<void>
  remove(options: { path: string }): Promise<void>
  fileSize(options: { path: string }): Promise<{ exists: boolean; bytes: number }>
  /** Resident memory now and its peak (Android: since resetPeakMemory; iOS: since launch). */
  memory(): Promise<{ residentBytes: number; peakBytes: number }>
  resetPeakMemory(): Promise<{ reset: boolean }>
  /** Copies a file in through the plugin's importer, as a picked file is. */
  importFile(options: { path: string }): Promise<{ path: string; name: string; bytes: number }>
  /** Android: saves to the gallery with the plugin's saver and imports it back from there. */
  galleryRoundTrip(options: { path: string }): Promise<{ uri: string; path: string; name: string; bytes: number }>
  device(): Promise<{
    model: string
    os: string
    cpus: number
    memoryBytes: number
    simulator: boolean
    /** Android: the ABI the app runs as, and the CPU's vector instruction sets. */
    abi?: string
    cpuFlags?: string
  }>
}

export const Host = registerPlugin<SelfTestHostPlugin>('SelfTestHost')

export interface RunOutcome extends EngineRunResult {
  id: string
  /** Every line it printed, in order, as the 'line' events brought them. */
  lines: EngineLine[]
  ms: number
}

const listeners = new Map<string, (line: EngineLine) => void>()
let subscribed: Promise<unknown> | null = null
let seq = 0

function subscribe(): Promise<unknown> {
  if (!subscribed) subscribed = Engine.addListener('line', (line) => listeners.get(line.id)?.(line))
  return subscribed
}

/** Runs a tool and collects its lines. */
export async function run(
  tool: EngineTool,
  args: string[],
  opts: { id?: string; onLine?: (line: EngineLine) => void } = {}
): Promise<RunOutcome> {
  await subscribe()
  const id = opts.id ?? `${tool}-${++seq}`
  const lines: EngineLine[] = []
  listeners.set(id, (line) => {
    lines.push(line)
    opts.onLine?.(line)
  })
  const started = performance.now()
  try {
    const result = await Engine.run({ id, tool, args })
    return { ...result, id, lines, ms: performance.now() - started }
  } finally {
    // Lines come before the result on both platforms; this keeps stragglers out of the next run's.
    setTimeout(() => listeners.delete(id), 1000)
  }
}

export function stdoutLines(r: RunOutcome): string[] {
  return r.lines.filter((l) => l.stream === 'stdout').map((l) => l.line)
}

export function stderrLines(r: RunOutcome): string[] {
  return r.lines.filter((l) => l.stream === 'stderr').map((l) => l.line)
}
