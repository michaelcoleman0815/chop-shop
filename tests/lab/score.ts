/**
 * A cut scored against the published edit (shared/raw/published): kept-word
 * precision and recall, the take chosen for each line said more than once,
 * running times, the opening line and the pauses. With the published video
 * itself, takes that read alike are told apart by their sound.
 *
 *   node scripts/lab.mjs score <out.json> <prepared.json> <cut.doc.json> <published.words.json> [published media]
 *
 * prepared.json is what `prepare` wrote, cut.doc.json what `v1` wrote, and
 * published.words.json what `hear` wrote for the published video.
 */
import { readFileSync, writeFileSync } from 'fs'
import { currentCut, resolveCut, type EditDoc } from '../../src/shared/edit'
import { takesOf } from '../../src/shared/raw'
import { scoreCut, type RawWord, type TimedText } from '../../src/shared/raw/published'
import { loudnessEnvelope } from '../../src/main/audio-envelope'
import { FFMPEG_PATH } from '../../src/main/ffmpeg'
import type { Envelope } from '../../src/shared/audio/snap'
import { fail } from './handlers'

/** Pearson correlation of two loudness stretches, the best within a third of a second of each other. */
function alike(a: Envelope, aFrom: number, aTo: number, b: Envelope, bFrom: number): number {
  const hop = a.hopSec
  const n = Math.round((aTo - aFrom) / hop)
  if (n < 20) return 0
  const a0 = Math.round(aFrom / hop)
  const b0 = Math.round(bFrom / hop)
  let best = -1
  for (let lag = -30; lag <= 30; lag++) {
    let sa = 0
    let sb = 0
    let k = 0
    for (let i = 0; i < n; i++) {
      const x = a.db[a0 + i]
      const y = b.db[b0 + lag + i]
      if (x === undefined || y === undefined) continue
      sa += Math.max(-60, x)
      sb += Math.max(-60, y)
      k++
    }
    if (k < n * 0.8) continue
    const ma = sa / k
    const mb = sb / k
    let num = 0
    let da = 0
    let db = 0
    for (let i = 0; i < n; i++) {
      const x = a.db[a0 + i]
      const y = b.db[b0 + lag + i]
      if (x === undefined || y === undefined) continue
      const p = Math.max(-60, x) - ma
      const q = Math.max(-60, y) - mb
      num += p * q
      da += p * p
      db += q * q
    }
    if (da > 0 && db > 0) best = Math.max(best, num / Math.sqrt(da * db))
  }
  return best
}

async function main(): Promise<void> {
  const [out, preparedPath, cutPath, publishedPath, media] = process.argv.slice(2)
  if (!out || !preparedPath || !cutPath || !publishedPath) throw new Error('usage: score <out.json> <prepared.json> <cut.doc.json> <published.words.json> [published media]')
  const doc = (JSON.parse(readFileSync(preparedPath, 'utf8')) as { prepared: { doc: EditDoc } }).prepared.doc
  const made = JSON.parse(readFileSync(cutPath, 'utf8')) as EditDoc
  const pub = JSON.parse(readFileSync(publishedPath, 'utf8')) as { words: TimedText[]; mediaSec?: number; durationSec: number }
  const raw: RawWord[] = doc.words.map((w) => ({ id: w.id, source: w.source, text: w.text, startSec: w.startSec, endSec: w.endSec }))
  const resolved = resolveCut(currentCut(made), made.words, made.sources)
  const text = new Map(made.words.map((w) => [w.id, w.text]))
  const cutWords = resolved.words.map((w) => ({ id: w.id, text: text.get(w.id) ?? w.text, startSec: w.outStart, endSec: w.outEnd }))

  let hear: ((p: { startSec: number; endSec: number }, r: { source: string; startSec: number; endSec: number }) => number) | undefined
  if (media) {
    const pubEnv = await loudnessEnvelope(FFMPEG_PATH, media)
    const rawEnv = new Map<string, Envelope>()
    for (const s of doc.sources) rawEnv.set(s.id, await loudnessEnvelope(FFMPEG_PATH, s.audio?.path ?? s.path))
    const offsetOf = new Map(doc.sources.map((s) => [s.id, s.audio?.offsetSec ?? 0]))
    hear = (p, r) => {
      const env = rawEnv.get(r.source)
      return env ? alike(pubEnv, p.startSec, p.endSec, env, r.startSec + (offsetOf.get(r.source) ?? 0)) : 0
    }
  }
  const groups = takesOf(doc).flatMap((a) => a.groups.map((g) => ({ label: g.label, takes: g.takes.map((t) => ({ from: t.from, to: t.to })) })))
  const score = scoreCut({
    raw,
    rawSec: doc.sources.reduce((s, x) => s + x.durationSec, 0),
    cut: { words: cutWords, durationSec: resolved.durationSec },
    published: { words: pub.words, durationSec: pub.mediaSec ?? pub.durationSec },
    groups,
    recover: hear ? { hear } : {}
  })
  const { edit, ...rest } = score
  writeFileSync(
    out,
    JSON.stringify(
      {
        ...rest,
        spans: edit.spans.map((s) => ({ ...s, startSec: Math.round(s.startSec * 100) / 100, endSec: Math.round(s.endSec * 100) / 100, pubStartSec: Math.round(s.pubStartSec * 100) / 100, pubEndSec: Math.round(s.pubEndSec * 100) / 100 }))
      },
      null,
      1
    )
  )
  process.stderr.write(
    `kept words: precision ${(rest.precision * 100).toFixed(1)}%, recall ${(rest.recall * 100).toFixed(1)}%; takes ${rest.takesSame}/${rest.takesBoth} the same; ` +
      `runs ${rest.runningSec.cut.toFixed(0)} s against ${rest.runningSec.published.toFixed(0)} s (raw ${rest.runningSec.raw.toFixed(0)} s); ` +
      `opens on the same line: ${rest.opening.same ? 'yes' : 'no'}\n`
  )
}

main().catch(fail)
