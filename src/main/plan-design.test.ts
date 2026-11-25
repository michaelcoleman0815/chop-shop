import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const os = await import('os')
  return { app: { getPath: () => os.tmpdir(), isPackaged: false, getAppPath: () => process.cwd() }, ipcMain: { handle: () => undefined } }
})

import { createDoc, currentCut, wordsFromTranscript, type EditDoc } from '../shared/edit'
import { lately, latelyLine, remember } from './lately'
import { DESIGN_SYSTEM, designBrief, GRAPHIC_TOOL, MAX_DESIGNS, readGraphic, type DesignOp } from './plan-design'

function talk(): EditDoc {
  const list = 'Google pays Apple billions to be the default in Safari every single year.'.split(' ').map((text, i) => ({ text, startSec: 0.4 + i * 0.4, endSec: 0.7 + i * 0.4 }))
  return createDoc({ id: 'd', title: 'Talk', source: { id: 's1', path: '/talk.mov', durationSec: 8, width: 1920, height: 1080, fps: 30 }, words: wordsFromTranscript(list, 's1') })
}
const op = (over: Partial<DesignOp> = {}): DesignOp => ({ op: 'design', from: 'w1', to: 'w10.end', room: 'left', brief: 'Who pays whom.', ...over })
const handed = (layers: unknown[]) => [{ type: 'tool_use', name: GRAPHIC_TOOL, input: { idea: 'x', layers } }]
const square = { kind: 'shape', shape: { type: 'rect', w: 100, h: 100 }, fill: '#FFFFFF', transform: { x: 200, y: 200 } }

describe('a graphic designed for one video', () => {
  it('is one a video, told what is said and when, and what else is on screen', () => {
    expect(MAX_DESIGNS).toBe(1)
    const doc = talk()
    const brief = designBrief(doc, currentCut(doc), op(), ['a figure counting'])
    expect(brief?.text).toContain('Who pays whom.')
    expect(brief?.text).toMatch(/Google \(0\.\d\d\)/)
    expect(brief?.text).toContain('so do something else: a figure counting')
    // The shot is shown as it will be framed, without the marker it was found with.
    expect(brief?.cut.motion ?? []).toEqual([])
    expect(designBrief(doc, currentCut(doc), op({ from: 'w999' }), [])).toBeNull()
  })

  it('is told to draw what is explained, never a figure of speech', () => {
    expect(DESIGN_SYSTEM).toMatch(/Never a figure of speech made into an object/)
  })

  it('takes the layers that can be drawn, and none of the person’s files', () => {
    const got = readGraphic(handed([square, { kind: 'image', icon: 'search', w: 50, h: 50, file: '/etc/passwd', asset: 'a1' }]))
    expect(got).toHaveLength(2)
    expect(JSON.stringify(got)).not.toMatch(/passwd|"a1"/)
    // Too little of it readable is no graphic.
    expect(readGraphic(handed([square, { kind: 'nope' }, { kind: 'nope' }]))).toBeNull()
    expect(readGraphic([{ type: 'text' }])).toBeNull()
  })
})

describe('what the last edits looked like', () => {
  it('is kept a line an edit, the newest first, and never the edit’s own', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lately-')), 'lately.json')
    const doc = talk()
    const ops = [
      { op: 'direction', set: { accent: '#E8692C', display: 'Anton', ground: 'light', idea: 'copper' } },
      { op: 'motion-add', kind: 'band', style: 'flow' },
      { op: 'motion-add', kind: 'band', style: 'flow' },
      { op: 'motion-add', kind: 'headline', style: '' }
    ] as never
    expect(latelyLine(doc, ops)).toBe('band flow x2, headline; #E8692C, Anton, light ground, copper')
    expect(latelyLine(doc, [])).toBeNull()
    for (let i = 0; i < 9; i++) await remember(path, { ...doc, id: `d${i}` }, ops)
    expect(await lately(path, 'd8')).toHaveLength(5)
    expect(await lately(path, 'other')).toHaveLength(6)
    expect(await lately(join(tmpdir(), 'nothing-here.json'), 'x')).toEqual([])
  })
})
