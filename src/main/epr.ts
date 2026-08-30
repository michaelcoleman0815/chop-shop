import { promises as fs } from 'fs'
import { basename } from 'path'

/**
 * Reads an Adobe Media Encoder preset.
 *
 * .epr is plain XML despite the opaque extension: a PremiereData tree of
 * ExporterParam nodes keyed by identifiers like ADBEVideoWidth. Only the
 * handful that map onto an encoder are read; codec GUIDs, colour management and
 * Adobe's own filter chain have no equivalent here and are ignored rather than
 * guessed at.
 */

export interface ExportPreset {
  name: string
  width: number | null
  height: number | null
  /** Bits per second, as Premiere stores it. */
  videoBitrate: number | null
  audioBitrate: number | null
  fps: number | null
}

/** Params are stored as sibling ParamIdentifier / ParamValue pairs. */
function readParam(xml: string, identifier: string): string | null {
  const at = xml.indexOf(`<ParamIdentifier>${identifier}</ParamIdentifier>`)
  if (at === -1) return null
  const value = /<ParamValue>([^<]*)<\/ParamValue>/.exec(xml.slice(at, at + 2000))
  return value ? value[1].trim() : null
}

function toNumber(raw: string | null): number | null {
  if (raw === null) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

export async function readEpr(path: string): Promise<ExportPreset> {
  const xml = await fs.readFile(path, 'utf8')
  if (!xml.includes('<PremiereData')) {
    throw new Error('That does not look like an Adobe encoder preset.')
  }

  // Premiere stores rate as a tick duration rather than a rate: ticks per
  // second divided by ticks per frame.
  const TICKS_PER_SEC = 254016000000
  const frameTicks = toNumber(readParam(xml, 'ADBEVideoFPS'))
  const fps = frameTicks ? Math.round((TICKS_PER_SEC / frameTicks) * 1000) / 1000 : null

  return {
    name: basename(path).replace(/\.epr$/i, ''),
    width: toNumber(readParam(xml, 'ADBEVideoWidth')),
    height: toNumber(readParam(xml, 'ADBEVideoHeight')),
    // Bitrates are stored in megabits in the target-bitrate fields.
    videoBitrate: (() => {
      const mbit = toNumber(readParam(xml, 'ADBEVideoTargetBitrate'))
      return mbit ? Math.round(mbit * 1_000_000) : null
    })(),
    audioBitrate: (() => {
      const kbit = toNumber(readParam(xml, 'ADBEAudioBitrate'))
      return kbit ? Math.round(kbit * 1000) : null
    })(),
    fps
  }
}
