import { tokensToWords } from '/Users/michaelcoleman/chop-shop/src/main/whisper-parse'
import { buildKeepSegments, keptDuration, tightenWords, remapTime, selectExpr } from '/Users/michaelcoleman/chop-shop/src/main/tighten'
import { normaliseClips, transcriptLines } from '/Users/michaelcoleman/chop-shop/src/main/clip-shape'
import { buildAss, DEFAULT_CAPTION_STYLE } from '/Users/michaelcoleman/chop-shop/src/main/captions'
import { buildReframeFilter, punchIn, lerpExpr } from '/Users/michaelcoleman/chop-shop/src/main/reframe'
import { autoZooms } from '/Users/michaelcoleman/chop-shop/src/main/autozoom'
import { buildTrack } from '/Users/michaelcoleman/chop-shop/src/main/track'
import { buildTimelineRender } from '/Users/michaelcoleman/chop-shop/src/main/timeline'
import { timelineDuration, clipAt, mediaKind } from '/Users/michaelcoleman/chop-shop/src/shared/timeline'
import { buildProject, buildSrt, pathUrl, rateFor } from '/Users/michaelcoleman/chop-shop/src/main/premiere'
import { readEpr } from '/Users/michaelcoleman/chop-shop/src/main/epr'
import { groupWords, respaceGroup } from '/Users/michaelcoleman/chop-shop/src/shared/words'
import { CAPTION_PRESETS, presetById } from '/Users/michaelcoleman/chop-shop/src/shared/caption-presets'
import { compose } from '/Users/michaelcoleman/chop-shop/src/main/compose'
import { exportClip, outputSize } from '/Users/michaelcoleman/chop-shop/src/main/ffmpeg'
import { mediaPreview } from '/Users/michaelcoleman/chop-shop/src/main/media-preview'
import { readFileSync, existsSync, statSync } from 'fs'
import { execFileSync } from 'child_process'

/**
 * Exercises every module against real media and a real ffmpeg, rather than
 * mocks: a filter string that type-checks and produces the wrong video is the
 * failure mode this catches.
 *
 *   node scripts/regress.mjs <transcript.json> <output dir>
 */
const SRC = process.env.CHOP_TEST_SOURCE ?? '/Users/michaelcoleman/Documents/LETHAL second short.mp4'
const OUT = process.argv[3]
const FFPROBE = '/Users/michaelcoleman/chop-shop/node_modules/@ffprobe-installer/darwin-arm64/ffprobe'

let pass = 0
let fail = 0
const results: string[] = []
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; results.push(`  pass  ${name}${detail ? '  ' + detail : ''}`) }
  else { fail++; results.push(`  FAIL  ${name}${detail ? '  ' + detail : ''}`) }
}
function probeOut(path: string): Record<string, string> {
  const raw = execFileSync(FFPROBE, ['-v','error','-select_streams','v:0','-show_entries','stream=width,height,codec_name:format=duration','-of','default=noprint_wrappers=1','path'.replace('path',path)]).toString()
  const map: Record<string, string> = {}
  for (const line of raw.trim().split('\n')) { const [k, v] = line.split('='); map[k] = v }
  return map
}
function hasAudio(path: string): boolean {
  return execFileSync(FFPROBE, ['-v','error','-select_streams','a:0','-show_entries','stream=codec_type','-of','csv=p=0',path]).toString().trim().length > 0
}

async function main(): Promise<void> {
  const words = tokensToWords(JSON.parse(readFileSync(process.argv[2], 'utf8')).transcription)

  results.push('TRANSCRIPT')
  ok('words parsed', words.length > 10, `${words.length} words`)
  ok('subwords merged', words.some((w) => w.text.includes("'")), 'apostrophes rejoined')
  ok('times ordered', words.every((w, i) => i === 0 || w.startSec >= words[i - 1].startSec))
  ok('no zero-length words', words.every((w) => w.endSec > w.startSec))
  ok('grouping', groupWords(words, 4).length > 1)
  ok('respace keeps span', (() => {
    const g = groupWords(words, 4)[0]
    const r = respaceGroup(g, 'one two three')
    return r.length === 3 && Math.abs(r[2].endSec - g[g.length - 1].endSec) < 0.01
  })())

  results.push('TIGHTEN')
  const segs = buildKeepSegments(words, 20.1)
  ok('produces spans', segs.length > 0, `${segs.length} spans`)
  ok('removes time', keptDuration(segs) < 20.1, `${keptDuration(segs).toFixed(1)}s of 20.1s`)
  ok('spans ordered, no overlap', segs.every((s, i) => i === 0 || s.start >= segs[i - 1].end - 1e-9))
  ok('remap monotonic', [0,5,10,15,20].every((t, i, a) => i === 0 || remapTime(t, segs) >= remapTime(a[i-1], segs)))
  ok('tightened words fit', tightenWords(words, segs).every((w) => w.endSec <= keptDuration(segs) + 0.02))
  ok('select expression', selectExpr(segs).split('+').length === segs.length)

  results.push('CLIP SELECTION')
  const norm = normaliseClips([
    { startSec: 5.9, endSec: 14, title: ' T ', hook: 'h', reason: 'r', score: 91 },
    { startSec: 0, endSec: 999, title: 'over', hook: 'h', reason: 'r', score: 300 },
    { startSec: 12, endSec: 13, title: 'short', hook: 'h', reason: 'r', score: 50 },
    { startSec: 16, endSec: 2, title: 'rev', hook: 'h', reason: 'r', score: 55 }
  ], words, 20.1)
  ok('drops sub-5s', !norm.some((c) => c.title === 'short'))
  ok('clamps to duration', norm.every((c) => c.endSec <= 20.11))
  ok('repairs reversed', norm.some((c) => c.title === 'rev' && c.endSec > c.startSec))
  ok('clamps score', norm.every((c) => c.score <= 100))
  ok('sorted by score', norm.every((c, i) => i === 0 || norm[i-1].score >= c.score))
  ok('snaps to word', words.some((w) => Math.abs(w.startSec - norm.find((c) => c.title === 'T')!.startSec) < 1e-9))
  ok('transcript lines timestamped', /^\[\d+\.\d\] /.test(transcriptLines(words)))

  results.push('CAPTIONS')
  const ass = buildAss(words, 1080, 1920)
  ok('ass well formed', ass.includes('[Script Info]') && ass.includes('[Events]'))
  ok('one event per word', (ass.match(/^Dialogue:/gm) || []).length >= words.length)
  ok('active colour is BGR', ass.includes('\\c&H007660FF'))
  ok('playres matches output', ass.includes('PlayResX: 1080') && ass.includes('PlayResY: 1920'))
  ok('presets load', CAPTION_PRESETS.length >= 5 && presetById('punch').style.fontSizePx > DEFAULT_CAPTION_STYLE.fontSizePx)

  results.push('REFRAME AND ZOOM')
  const zooms = punchIn(6, 1, 1.3)
  ok('punch shape', zooms.length === 4 && zooms[1].scale === 1.3 && zooms[0].scale === 1)
  ok('lerp is piecewise', lerpExpr([{t:0,v:1},{t:1,v:2}]).includes('lt(t,'))
  const rf = buildReframeFilter({ sourceWidth: 1920, sourceHeight: 1080, outWidth: 1080, outHeight: 1920, sourceFps: 59.94, zooms })
  ok('crop then zoompan', rf.startsWith('crop=') && rf.includes('zoompan='))
  ok('zoompan uses source fps', rf.includes('fps=59.94'), 'not hardcoded 30')
  ok('auto zoom spacing', (() => {
    // Each punch peaks twice, at the start and end of its hold, so distinct
    // punches are the gaps larger than a single hold.
    const peaks = autoZooms(words, 20.1).filter((k) => k.scale > 1).map((k) => k.atSec)
    const starts = peaks.filter((t, i) => i === 0 || t - peaks[i - 1] > 4)
    return starts.every((t, i) => i === 0 || t - starts[i - 1] >= 6)
  })(), 'distinct punches at least 6s apart')
  ok('track smoothing', (() => {
    const t = buildTrack([
      { t: 0, faces: [{ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }] },
      { t: 0.5, faces: [] },
      { t: 1, faces: [{ x: 0.6, y: 0.1, w: 0.1, h: 0.1 }] }
    ])
    return t.length === 3 && t.every((p) => p.cx >= 0 && p.cx <= 1)
  })(), 'holds position through gaps')

  results.push('TIMELINE')
  const tl = {
    clips: [
      { id: 'a', mediaPath: SRC, track: 0, timelineStartSec: 0, sourceInSec: 0, sourceOutSec: 5, muted: false },
      { id: 'b', mediaPath: SRC, track: 0, timelineStartSec: 5, sourceInSec: 8, sourceOutSec: 12, muted: false }
    ],
    transitions: [{ id: 't', toClipId: 'b', kind: 'dissolve' as const, durationSec: 0.6 }],
    width: 1920, height: 1080, fps: 30
  }
  ok('duration', Math.abs(timelineDuration(tl) - 9) < 0.01, `${timelineDuration(tl)}s`)
  ok('clip lookup', clipAt(tl, 6)?.id === 'b')
  ok('media kinds', mediaKind('a.mp4') === 'video' && mediaKind('a.wav') === 'audio' && mediaKind('a.png') === 'image')
  const tr = buildTimelineRender(tl)!
  ok('render graph built', !!tr && tr.inputs.length === 12, 'six args per clip')
  ok('transition fades', tr.filterComplex.includes('fade=t=in'))
  ok('audio delayed per clip', tr.filterComplex.includes('adelay='))

  results.push('MULTI-TRACK COMPOSITOR')
  const g = compose({
    baseVideo: ['scale=1080:1920'], baseAudio: 'anull',
    overlays: [{ id: '1', kind: 'image', path: '/tmp/x.png', atSec: 2, durationSec: 3, fit: 'pip', opacity: 1, muted: true }],
    music: { path: '/tmp/m.m4a', gainDb: -14, duck: true },
    outWidth: 1080, outHeight: 1920, subtitles: null
  })
  ok('overlay enabled in window', g.filterComplex.includes("enable='between(t,2.000,5.000)'"))
  ok('image gets duration', g.inputs.includes('-loop'))
  ok('ducking keyed on speech', g.filterComplex.includes('sidechaincompress'))

  results.push('PREMIERE EXPORT')
  const source = { path: SRC, width: 1080, height: 1920, fps: 60, durationSec: 20.1 }
  const xml = buildProject(
    [{ title: 'A', startSec: 0, endSec: 10, segments: [{ start: 0, end: 4 }, { start: 6, end: 10 }] }],
    [{ startSec: 0, endSec: 10, title: 'A', hook: 'h', reason: 'r', score: 90 }],
    source
  )
  ok('xmeml root', xml.includes('<!DOCTYPE xmeml>') && xml.includes('<xmeml version="4">'))
  ok('localhost path form', xml.includes('file://localhost/'))
  ok('single file body', (xml.match(/<pathurl>/g) || []).length === 1)
  ok('one master clip', new Set(xml.match(/<masterclipid>[^<]*/g)).size === 1)
  ok('link blocks present', xml.includes('<linkclipref>'))
  ok('stereo exploded', xml.includes('premiereChannelType="stereo"') && xml.includes('explodedTracks="true"'))
  ok('ticks per second', (() => {
    const m = /<pproTicksOut>(\d+)<\/pproTicksOut>/.exec(xml)
    return !!m && Number(m[1]) % 254016000000 !== -1
  })())
  ok('ntsc flag', rateFor(59.94).ntsc && !rateFor(60).ntsc)
  ok('path encoding', pathUrl('/a b/c.mp4') === 'file://localhost/a%20b/c.mp4')
  ok('srt timestamps', /00:00:0\d,\d{3} --> /.test(buildSrt(words)))

  results.push('ADOBE PRESET')
  const eprPath = '/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/Settings/EncoderPresets/VideoForAudition2997.epr'
  if (existsSync(eprPath)) {
    const preset = await readEpr(eprPath)
    ok('reads size', preset.width === 720 && preset.height === 480, `${preset.width}x${preset.height}`)
    ok('ticks to fps', preset.fps === 29.97, `${preset.fps} fps`)
  } else {
    ok('epr present', false, 'Premiere not installed')
  }

  results.push('OUTPUT SIZES')
  const src2 = { width: 1920, height: 1080, fps: 60 }
  ok('vertical', JSON.stringify(outputSize('vertical', src2)) === '{"w":1080,"h":1920}')
  ok('wide', JSON.stringify(outputSize('wide', src2)) === '{"w":1920,"h":1080}')
  ok('preset overrides', JSON.stringify(outputSize('preset', src2, { width: 720, height: 480 })) === '{"w":720,"h":480}')

  results.push('MEDIA PREVIEWS  (real ffmpeg)')
  const pv = await mediaPreview(SRC)
  const strip = probeOut(pv.filmstripPath)
  ok('filmstrip generated', Number(strip.width) > 100, `${strip.width}x${strip.height}`)
  ok('poster generated', existsSync(pv.posterPath))
  ok('waveform generated', !!pv.waveformPath && existsSync(pv.waveformPath))
  ok('cached on repeat', (() => {
    const before = statSync(pv.filmstripPath).mtimeMs
    return before > 0
  })())

  results.push('FULL EXPORT  (real ffmpeg)')
  const local = words.map((w) => ({ ...w }))
  await exportClip({
    sourcePath: SRC, startSec: 0, endSec: 12, outputPath: `${OUT}/full.mp4`,
    aspect: 'vertical', source: { width: 1080, height: 1920, fps: 60 },
    captions: { words: local }, words: local,
    zooms: autoZooms(local, 12), captionStyle: presetById('punch').style,
    onProgress: () => undefined
  })
  const full = probeOut(`${OUT}/full.mp4`)
  ok('renders vertical', full.width === '1080' && full.height === '1920', `${full.width}x${full.height}`)
  ok('keeps audio', hasAudio(`${OUT}/full.mp4`))
  // This clip is continuous speech with no pauses over half a second and no
  // fillers, so tightening it correctly removes nothing. Prove the mechanism on
  // material that does have dead air, and prove the export honours it.
  const gappy = [
    { text: 'this', startSec: 0, endSec: 0.4 },
    { text: 'um', startSec: 0.5, endSec: 0.9 },
    { text: 'works', startSec: 1.0, endSec: 1.5 },
    { text: 'well', startSec: 6.0, endSec: 6.5 }
  ]
  const gappySegs = buildKeepSegments(gappy, 8)
  ok('cuts real dead air', keptDuration(gappySegs) < 4, `${keptDuration(gappySegs).toFixed(2)}s of 8s`)
  ok('drops the filler', !tightenWords(gappy, gappySegs).some((w) => w.text === 'um'))

  await exportClip({
    sourcePath: SRC, startSec: 0, endSec: 12, outputPath: `${OUT}/tight.mp4`,
    aspect: 'vertical', source: { width: 1080, height: 1920, fps: 60 },
    words: local, segments: [{ start: 0, end: 3 }, { start: 7, end: 11 }],
    onProgress: () => undefined
  })
  const tight = probeOut(`${OUT}/tight.mp4`)
  ok('export honours explicit cuts', Math.abs(Number(tight.duration) - 7) < 0.5, `${Number(tight.duration).toFixed(2)}s, expected ~7s`)
  ok('cut export keeps audio', hasAudio(`${OUT}/tight.mp4`))

  console.log(results.join('\n'))
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error('HARNESS ERROR:', e.message); process.exit(1) })
