import { describe, expect, it, vi } from 'vitest'

/**
 * A clip open in the editor stays open while work runs in its chat, as one can't be opened then: Back to the chat (the
 * screen set to the thread, which leaves the clip) is refused and says why, so a paid web search from its panel comes
 * back to the clip it was for. With nothing running, it leaves and opens as before. The real useClipping, React's hooks
 * as plain functions.
 */

vi.mock('react', () => ({
  useRef: <T,>(v: T) => ({ current: v }),
  useState: <T,>(v: T | (() => T)) => [typeof v === 'function' ? (v as () => T)() : v, () => undefined],
  useCallback: <T,>(f: T) => f,
  useEffect: () => undefined,
  useMemo: <T,>(f: () => T) => f()
}))
vi.mock('./api', () => ({ api: {}, mediaUrlFor: (p: string) => `media://${p}` }))

import { createDoc, type EditDoc } from '../../../shared/edit'
import type { Project } from '../../../shared/types'
import { useClipping } from './useClipping'

const doc = (id: string): EditDoc =>
  createDoc({ id, title: id, source: { id: 's1', path: `/${id}.mp4`, durationSec: 30, width: 1920, height: 1080, fps: 30 }, words: [] })

function app(running: () => string | null) {
  const own = doc('own')
  const clipDoc = doc('clip-1')
  const project = {
    id: 'p',
    name: 'A',
    path: '/A.cutalong',
    mode: 'cut',
    media: [],
    chat: [],
    edit: own,
    clipping: { v: 1, runs: [], clips: [{ id: 'c1', run: 1, source: '/long.mp4', startSec: 0, endSec: 30, title: 'A clip', hook: '', reason: '', score: 1, kept: true, doc: clipDoc }] }
  } as unknown as Project
  const docRef = { current: clipDoc as EditDoc | null }
  const toasts: string[] = []
  const screens: string[] = []
  const shown: (EditDoc | null)[] = []
  const clipping = useClipping({
    projectRef: { current: project },
    docRef,
    screen: 'editor',
    setDocState: (d) => shown.push(d),
    setMediaUrl: () => undefined,
    setScreen: (s) => screens.push(s),
    push: () => 'm',
    patch: () => undefined,
    persist: async () => undefined,
    ensureProject: async () => project,
    setToast: (t) => (t ? toasts.push(t.text) : undefined),
    during: (work) => work(),
    exportingNow: { current: null },
    clearEditor: () => undefined,
    busy: running,
    stay: running
  })
  return { clipping, docRef, toasts, screens, shown, own, clipDoc }
}

describe('a clip open while work runs in its chat', () => {
  it('is not left for the chat: it stays open, back in the editor, and says why', () => {
    const w = app(() => 'One moment, your web search is still running.')
    expect(w.clipping.leave()).toBe(false)
    expect(w.docRef.current?.id).toBe('clip-1')
    expect(w.toasts).toEqual(['One moment, your web search is still running.'])
    expect(w.screens).toEqual(['editor'])
    expect(w.shown).toEqual([])
  })

  it('with nothing running, is left for the chat’s own edit, as before', () => {
    const w = app(() => null)
    expect(w.clipping.leave()).toBe(true)
    expect(w.docRef.current?.id).toBe('own')
    expect(w.shown.map((d) => d?.id)).toEqual(['own'])
    expect(w.toasts).toEqual([])
  })

  it('and another clip is not opened then either; with nothing running it opens', () => {
    const busy = app(() => 'A video is being made in this chat. Open the clip when it’s done, or stop it first.')
    busy.docRef.current = busy.own
    busy.clipping.open('c1')
    expect(busy.docRef.current?.id).toBe('own')
    expect(busy.toasts).toEqual(['A video is being made in this chat. Open the clip when it’s done, or stop it first.'])
    const free = app(() => null)
    free.docRef.current = free.own
    free.clipping.open('c1')
    expect(free.docRef.current?.id).toBe('clip-1')
    expect(free.screens).toEqual(['editor'])
  })
})
