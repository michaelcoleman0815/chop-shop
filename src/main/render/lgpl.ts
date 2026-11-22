import listed from './gpl-filters.json'

/**
 * What a phone's ffmpeg does not have. It is built LGPL only, with libass,
 * freetype, fribidi, harfbuzz, zimg, libwebp and dav1d, and encodes video
 * with the phone's hardware: no x264, and none of the filters FFmpeg's
 * configure marks GPL (perspective among them). The phone's renders are
 * checked against this list in the tests and by the dev bridge.
 */

const MISSING = new Set([...listed.gpl, ...listed.libraries])
const ENCODERS = new Set(listed.encoders)

/** The filters a filtergraph names, in order: [in]scale=1:2[out];[a]amix@m=inputs=2 gives scale, amix. */
export function filterNames(graph: string): string[] {
  const names: string[] = []
  let part = ''
  let quoted = false
  const flush = (): void => {
    const body = part.replace(/^\s*(\[[^\]]*\]\s*)+/, '').trim()
    const name = /^([A-Za-z0-9_]+)/.exec(body)?.[1]
    if (name) names.push(name)
    part = ''
  }
  for (let i = 0; i < graph.length; i++) {
    const c = graph[i]
    if (c === '\\') {
      part += c + (graph[i + 1] ?? '')
      i++
      continue
    }
    if (c === "'") quoted = !quoted
    if (!quoted && (c === ',' || c === ';')) flush()
    else part += c
  }
  flush()
  return names
}

/** Filters and encoders an ffmpeg command names that a phone's ffmpeg lacks. Nothing when it can run. */
export function missingOnPhone(args: string[]): string[] {
  const out = new Set<string>()
  for (let i = 0; i < args.length - 1; i++) {
    const flag = args[i]
    const value = args[i + 1]
    if (flag === '-filter_complex' || flag === '-lavfi' || /^-(vf|af|filter)(:[av])?$/.test(flag)) {
      for (const name of filterNames(value)) if (MISSING.has(name)) out.add(name)
    }
    if (/^-(c|codec)(:[av])?$/.test(flag) && ENCODERS.has(value)) out.add(value)
  }
  return [...out]
}
