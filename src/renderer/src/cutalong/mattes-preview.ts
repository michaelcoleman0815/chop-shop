import { useEffect, useMemo, useRef, useState } from 'react'
import { currentCut, currentVersion, type EditDoc, type Resolved } from '../../../shared/edit'
import { cutoutView, type CutoutTrack, type LoadedMasks } from '../../../shared/fx'
import { designSize, timelineFor, type DrawResources } from '../../../shared/motion'
import { cutoutMattes, matteWants, mediaOf } from '../../../shared/tracks'
import { api } from './api'
import { loadMask } from './fx-preview'

/**
 * The person and objects as mattes in the editor's preview: the cut-outs
 * the edit's mattes want (main/matte-cutouts, through fx:cutouts), each mask
 * loaded as the window reads it, placed in the frame by the code the export
 * places them with (shared/tracks/mattes), for the layer canvases to cut
 * clips to and draw graphics behind the person with. Asked for again when
 * what wants them changes; none off a Mac.
 */

const makeCanvas = (width: number, height: number): HTMLCanvasElement => {
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  return c
}

export function useMattes(doc: EditDoc, resolved: Resolved, behind: boolean): DrawResources['mattes'] | undefined {
  const cut = currentCut(doc)
  const wants = useMemo(
    () => matteWants(cut, timelineFor(cut, resolved, doc.words), mediaOf(doc.assets, doc.sources)),
    [cut, resolved, doc.words, doc.assets, doc.sources]
  )
  const need = wants.length > 0 || behind
  // Asked again when what wants a cut-out, the shape or the version changes.
  const key = need ? `${currentVersion(doc).n} ${cut.aspect} ${JSON.stringify(wants)} ${behind}` : ''
  const [cutouts, setCutouts] = useState<{ key: string; tracks: CutoutTrack[]; loaded: LoadedMasks } | null>(null)
  const docRef = useRef(doc)
  docRef.current = doc
  useEffect(() => {
    if (!key) return
    let live = true
    void api
      .fxCutouts(docRef.current)
      .then(async ({ tracks }) => {
        const files = [...new Set(tracks.flatMap((t) => t.samples.flatMap((s) => s.masks.map((m) => m.file))))]
        const masks = await Promise.all(files.map(loadMask))
        const loaded: LoadedMasks = new Map()
        files.forEach((f, i) => {
          const m = masks[i]
          if (m) loaded.set(f, m)
        })
        if (live) setCutouts({ key, tracks, loaded })
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [key])

  const first = doc.sources.find((s) => s.id === resolved.pieces[0]?.source) ?? doc.sources[0]
  const tracks = cutouts && cutouts.key === key ? cutouts.tracks : null
  return useMemo(() => {
    if (!tracks || tracks.length === 0 || !cutouts) return undefined
    const frame = designSize(cut.aspect, first ?? { width: 1920, height: 1080 })
    return cutoutMattes(cutoutView({ cut, resolved, sources: doc.sources, frame, tracks, loaded: cutouts.loaded }), makeCanvas)
    // The cut-outs, the timing and the frame's shape are what the mattes are made of.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, resolved, cut.aspect, first])
}

/** A picture loaded with leave to read it (from the media server), for a chroma key's pass over its pixels. */
const readable = new Map<string, Promise<HTMLImageElement | null>>()
export function loadReadablePicture(url: string, cors: 'anonymous' | undefined): Promise<HTMLImageElement | null> {
  let hit = readable.get(url)
  if (!hit) {
    hit = new Promise((resolve) => {
      const img = new Image()
      if (cors && !url.startsWith('data:')) img.crossOrigin = cors
      img.onload = () => resolve(img)
      img.onerror = () => resolve(null)
      img.src = url
    })
    readable.set(url, hit)
  }
  return hit
}
