import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const os = await import('os')
  return {
    app: { getPath: () => os.tmpdir(), isPackaged: false, getAppPath: () => process.cwd() },
    ipcMain: { handle: () => undefined },
    dialog: {},
    net: { fetch: async () => { throw new Error('no network') } },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})
vi.mock('./apikey', () => ({ readApiKey: () => null, hasApiKey: () => false, currentProvider: () => 'anthropic' }))

import { sceneForCut, subtitlePass } from './motion-render'
import { exportCues } from './upload-kit'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript, type Op } from '../shared/edit'
import { drawsCaptions } from '../shared/motion'
import { uploadMessage } from '../shared/upload'

/**
 * An export with captions off gets an .srt/.vtt "for viewers to turn on".
 * Burned-in captions wait while a card (a kinetic title, a screenshot, a
 * phone graphic, an end card) is up, so the subtitle pass leaves the words
 * said under it out. Nothing is burned in here, so the viewer's captions
 * carry every word, card or not.
 */

const SAID =
  'Most people never look at this setting. The camera is the real upgrade here, and the battery lasts two whole days. It is brighter outside too, which matters when you film on the street.'

function talk(ops: Op[]) {
  const words = SAID.split(' ').map((text, i) => ({ text, startSec: 0.4 + i * 0.35, endSec: 0.65 + i * 0.35 }))
  const base = createDoc({
    id: 'd',
    title: 'talk',
    source: { id: 's1', path: '/a.mov', durationSec: 16, width: 1920, height: 1080, fps: 30 },
    words: wordsFromTranscript(words, 's1')
  })
  const r = applyOps(currentCut(base), ops, { words: base.words, sources: base.sources })
  expect(r.rejected).toEqual([])
  const cut = r.cut
  const resolved = resolveCut(cut, base.words, base.sources)
  const scene = sceneForCut({ cut, resolved, words: base.words, sources: base.sources, brand: null })
  return { cut, resolved, scene, pass: subtitlePass(cut, resolved, scene) }
}

/** A kinetic title quoting the speech, from w9 ("The camera is ..."). */
const TITLE = { op: 'motion-add', kind: 'title', from: 'w9', to: '', text: ['The camera is', 'the real upgrade'] } as Op

describe('captions off: the closed captions beside the export', () => {
  it('carry the words said under a card', () => {
    const { cut, resolved, scene, pass } = talk([{ op: 'captions', set: { on: false } }, TITLE])
    expect(scene.items.some((i) => i.kind === 'title')).toBe(true)
    // The pass leaves the card's words out, as burned-in captions do.
    expect(pass.resolved.words.length).toBeLessThan(resolved.words.length)
    const { cues, burned } = exportCues({ cut, resolved, pass, scene, width: 1920 })
    expect(burned).toBe(false)
    expect(cues.flatMap((c) => c.text.split(' '))).toEqual(resolved.words.map((w) => w.text))
    // No silent stretch while the person keeps talking.
    expect(cues.find((c, i) => i > 0 && c.start - cues[i - 1].end > 1)).toBeUndefined()
    const said = uploadMessage({
      titles: ['a', 'b', 'c'],
      description: '',
      tags: [],
      by: 'local',
      why: 'off',
      captions: { pages: cues.length, burned },
      chapters: 0,
      short: false,
      credits: 0,
      files: { srt: 'x.srt', vtt: 'x.vtt', description: 'd', titles: 't' }
    }).text
    expect(said).toMatch(/turn on/)
  })
})

describe('captions burned in: the files beside the export', () => {
  it('match the picture: the words under the card wait, as they do on screen', () => {
    const { cut, resolved, scene, pass } = talk([TITLE])
    const { cues, burned } = exportCues({ cut, resolved, pass, scene, width: 1920 })
    expect(burned).toBe(true)
    if (drawsCaptions(cut.captions)) return // drawn by the graphics: drawnCues, in upload-kit.test
    expect(cues.flatMap((c) => c.text.split(' '))).toEqual(pass.resolved.words.map((w) => w.text))
    expect(cues.flatMap((c) => c.text.split(' ')).length).toBeLessThan(resolved.words.length)
  })
})
