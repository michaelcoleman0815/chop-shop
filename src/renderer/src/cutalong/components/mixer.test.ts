import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, wordsFromTranscript, type Cut, type Op } from '../../../../shared/edit'
import { Mixer } from './Mixer'

/**
 * The Mix tab as it draws a cut: a strip for the voice, each track that
 * sounds and the music, each with its fader and pan at the playhead, mute and
 * solo, and its effects with their few settings. What it does when used is
 * driven in the browser preview; this holds what it shows.
 */

const words = wordsFromTranscript(
  ['So', 'this', 'is', 'the', 'new', 'mic'].map((text, i) => ({ text, startSec: 0.2 + i * 0.4, endSec: 0.5 + i * 0.4 })),
  's1'
)
const doc = createDoc({ id: 'd', title: 't', source: { id: 's1', path: '/take.mp4', durationSec: 4, width: 1080, height: 1920, fps: 30 }, words })

function cutWith(ops: Op[]): Cut {
  const r = applyOps(currentCut(doc), ops, { words: doc.words, sources: doc.sources, assets: [] })
  expect(r.rejected).toEqual([])
  return r.cut
}

const render = (cut: Cut, time = 1): string =>
  renderToStaticMarkup(createElement(Mixer, { cut, time, durationSec: 4, onOps: () => undefined, onSeek: () => undefined }))

describe('the Mix tab', () => {
  const cut = cutWith([
    { op: 'clip-add', kind: 'sound', src: '/ding.wav', from: 'start', to: '2s' },
    { op: 'clip-add', kind: 'text', text: { value: 'HI' }, from: 'start', to: '1s' },
    { op: 'music', set: { path: '/bed.mp3' } },
    { op: 'mix', target: 'voice', gainDb: -6, pan: -0.5 },
    {
      op: 'mix',
      target: 't1',
      gainDb: { keys: [{ t: 0, v: 0 }, { t: 2, v: -12 }] },
      add: [
        { kind: 'eq', bypass: false, bands: [{ type: 'notch', freq: 60, gainDb: 0, q: 10 }] },
        { kind: 'gate', bypass: true, thresholdDb: -45, rangeDb: -30, attackMs: 5, releaseMs: 200 }
      ]
    },
    { op: 'mix', target: 'music', mute: true }
  ] as Op[])
  const html = render(cut)

  it('has a strip for the voice, the sound track and the music, and none for a track of titles', () => {
    expect([...html.matchAll(/<span class="cl-mix-title">([^<]+)</g)].map((m) => m[1])).toEqual(['Voice', 'Sound 1', 'Music'])
  })

  it('reads each fader and pan at the playhead, its keys along the video', () => {
    expect(html).toContain('<output class="cl-mix-readout">-6.0 dB</output>')
    expect(html).toContain('<output class="cl-mix-readout">L 50</output>')
    // Halfway down its ramp at 1 s.
    expect(html).toContain('<output class="cl-mix-readout">-6.0 dB</output><button type="button" class="cl-key-toggle"')
    expect(html).toContain('aria-label="Keys on Sound 1’s level"')
    expect(html).toContain('aria-label="Key at 2.0 s: -12.0 dB"')
  })

  it('says what is muted, and shows mute and solo as pressed or not', () => {
    expect(html).toMatch(/class="cl-mix-strip unheard"><div class="cl-mix-head"><span class="cl-mix-name"><span class="cl-mix-title">Music<\/span><span class="cl-project-meta">Muted\.<\/span>/)
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(2)
  })

  it('lists the effects in order with their settings, says which the preview leaves out, and offers the rest', () => {
    expect([...html.matchAll(/<span class="cl-mix-fx-name">([^<]+)</g)].map((m) => m[1])).toEqual(['EQ', 'Gate'])
    expect(html).toContain('class="cl-mix-fx bypassed"')
    expect(html).toContain('Heard in the export. The preview plays without it.')
    expect(html).toContain('<option value="notch" selected="">Notch</option>')
    expect((html.match(/<option value="" selected="">Add an effect<\/option>/g) ?? []).length).toBe(3)
    expect(html).toContain('aria-label="Take the EQ off"')
  })

  it('says only the soloed sounds are heard while one is', () => {
    const soloed = render(cutWith([{ op: 'mix', target: 'voice', solo: true } as Op]))
    expect(soloed).toContain('Only the soloed sounds are heard, here and in the export.')
  })
})
