/**
 * The app's own transcription of one file (main/transcribe): verbatim, as raw
 * footage is heard (the verbatim prompt, no carried text, word onsets, a
 * second listen where words went missing), or tidy, as /clipping hears it.
 * Used for the published video, so its words are written the way the raw's are.
 *
 *   node scripts/lab.mjs hear <out.json> <verbatim|tidy> <base.en|small.en|medium.en> <file> [startSec durationSec]
 */
import { writeFileSync } from 'fs'
import { transcribe, type WhisperModel } from '../../src/main/transcribe'
import { probe } from '../../src/main/ffmpeg'
import { fail, progressLogger } from './handlers'

async function main(): Promise<void> {
  const [out, mode, model, file, start, length] = process.argv.slice(2)
  if (!out || !file || (mode !== 'verbatim' && mode !== 'tidy')) throw new Error('usage: hear <out.json> <verbatim|tidy> <model> <file> [start length]')
  const t0 = Date.now()
  const log = progressLogger()
  const meta = await probe(file)
  const startSec = start ? Number(start) : 0
  const durationSec = length ? Number(length) : meta.durationSec - startSec
  const t = await transcribe(file, model as WhisperModel, durationSec, (p, stage) => log(stage, p), startSec, mode === 'verbatim' ? { names: [] } : undefined)
  const sec = (Date.now() - t0) / 1000
  writeFileSync(out, JSON.stringify({ mode, model, startSec, durationSec, mediaSec: meta.durationSec, sec, words: t.words }))
  process.stderr.write(`${t.words.length} words in ${sec.toFixed(0)} s\n`)
}

main().catch(fail)
