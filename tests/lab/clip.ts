/**
 * /clipping, the app's own run: main/clipping findClips with the app's
 * default tools (whisper as /clipping calls it, the audio map, the frozen
 * picture, the shot cuts, and whoever picks: Claude with a key, Ollama when
 * it runs, otherwise measuring). The brand is one with the niche given.
 *
 *   node scripts/lab.mjs clip <out.json> <niche|-> <what was typed|-> <file>
 *
 * Writes each clip (start, end, title, hook, reason, score, how long it
 * plays, its words), the recording's plan, the notes, the reply, the
 * timings, and the clip-quality verdicts (shared/clip-quality).
 */
import { createHash } from 'crypto'
import { promises as fs, writeFileSync } from 'fs'
import { join } from 'path'
import { defaultTools, findClips } from '../../src/main/clipping'
import { judgeClips } from '../../src/shared/clip-quality'
import { EMPTY_BRAND } from '../../src/shared/brand'
import { currentCut, resolveCut } from '../../src/shared/edit'
import type { SuggestedClip, TranscriptWord } from '../../src/shared/types'
import { fail, progressLogger } from './handlers'

/** The words /clipping kept for a recording, read the way main/clipping keys them. */
async function keptWords(dir: string, path: string): Promise<TranscriptWord[]> {
  try {
    const stat = await fs.stat(path)
    const key = createHash('sha1').update(`${path} ${stat.mtimeMs} ${stat.size}`).digest('hex').slice(0, 16)
    return ((JSON.parse(await fs.readFile(join(dir, `${key}.json`), 'utf8')) as { words: TranscriptWord[] | null }).words ?? [])
  } catch {
    return []
  }
}

async function main(): Promise<void> {
  const [out, niche, ask, file] = process.argv.slice(2)
  if (!out || !file) throw new Error('usage: clip <out.json> <niche|-> <ask|-> <file>')
  const t0 = Date.now()
  const log = progressLogger()
  const base = defaultTools()
  const brand = { ...EMPTY_BRAND, id: 'lab', name: 'Lab', niche: niche === '-' ? '' : niche, autoApply: false }
  const found = await findClips({ paths: [file], ask: ask === '-' ? '' : ask }, { ...base, brand: async () => brand }, (p) =>
    log(p.stage, p.percent)
  )
  if (!found.ok) throw new Error(found.message)
  const words = await keptWords(base.cacheDir, file)
  const suggested = found.clips.map((c) => ({
    startSec: c.startSec,
    endSec: c.endSec,
    title: c.title,
    hook: c.hook,
    reason: c.reason,
    score: c.score
  })) as unknown as SuggestedClip[]
  const verdicts = judgeClips(suggested, words)
  const clips = found.clips.map((c, i) => {
    const resolved = resolveCut(currentCut(c.doc), c.doc.words, c.doc.sources)
    return {
      startSec: c.startSec,
      endSec: c.endSec,
      title: c.title,
      hook: c.hook,
      reason: c.reason,
      score: c.score,
      playsSec: resolved.durationSec,
      text: resolved.words.map((w) => w.text).join(' '),
      faults: verdicts[i]?.faults ?? []
    }
  })
  const sec = (Date.now() - t0) / 1000
  writeFileSync(
    out,
    JSON.stringify(
      { by: found.by, model: found.model, recordings: found.recordings, notes: found.notes, timings: found.timings, reply: found.reply, clips, words: words.length, sec },
      null,
      1
    )
  )
  process.stderr.write(`${clips.length} clips in ${sec.toFixed(0)} s, picked by ${found.by}\n`)
}

main().catch(fail)
