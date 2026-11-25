import { createCanvas, ImageData, type Canvas } from '@napi-rs/canvas'
import { is } from '@electron-toolkit/utils'
import { BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { shutterFor } from '../shared/motion/draw'
import { fontInfo } from '../shared/motion/fonts'
import type { Scene3DLayer, Size, VideoLayer } from '../shared/motion/types'
import type { HostAsk, HostReply } from '../shared/three/host-protocol'
import { isModelFile, isVideoFile, TITLE_3D_FACE, type Object3D } from '../shared/three/spec'
import { decodeSize, videoFacts, videoFrames, type VideoFrames } from './video-frames'

/**
 * 3D clips' frames for the export's compositor. The scene builder the editor
 * previews with (shared/three) runs in a hidden offscreen window, the export's
 * 3D page (renderer/three.html): each clip is sent there once, with its
 * pictures', models' and faces' files as bytes, and each frame is asked for
 * by its moment, so frames come out the same however long each takes. A
 * video card's frames are decoded by ffmpeg here (main/video-frames) and sent
 * with the frame they belong to. The compositor draws synchronously, so
 * `prepare` draws the 3D clips on screen at the moment about to be drawn and
 * `frame` hands back what came back.
 *
 * At most the clips on screen are held, each as one frame; a clip that has
 * ended is let go of in the page too, and the window closes with the export
 * or as soon as it is cancelled.
 */

export interface Scene3DFrames {
  /** Draws every 3D layer on screen at `t`; lets go of those that are not. */
  prepare(t: number, layers: Scene3DLayer[]): Promise<void>
  /** The frame `prepare` drew for a layer. */
  frame(layer: Scene3DLayer): CanvasImageSource | null
  close(): void
}

export interface Scene3DFramesOptions {
  ffmpeg: string
  fps: number
  /** The output's pixels, which every 3D frame is drawn at. */
  pixels: Size
  fontsDir: string | null
  signal?: AbortSignal
}

/** How long the page has to answer one message before the export gives up on it. */
const ANSWER_MS = 60_000
/** Files bigger than this are not sent to the page. */
const MAX_FILE_BYTES = 200 * 1024 * 1024
/** A video card is decoded no bigger than this on its long side. */
const VIDEO_CARD_PX = 1280

class Host {
  private readonly win: BrowserWindow
  private next = 1
  private readonly waiting = new Map<number, { ok: (r: HostReply) => void; fail: (e: Error) => void }>()
  readonly ready: Promise<void>
  private gone: Error | null = null

  constructor() {
    this.win = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      webPreferences: {
        preload: join(__dirname, '../preload/three.js'),
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false
      }
    })
    const wc = this.win.webContents
    wc.setAudioMuted(true)
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', (e) => e.preventDefault())
    let ready: () => void = () => undefined
    let failed: (e: Error) => void = () => undefined
    this.ready = new Promise<void>((ok, fail) => {
      ready = ok
      failed = fail
    })
    wc.ipc.on('scene3d-reply', (_e, id: number, reply: HostReply) => {
      if (id === 0) return ready()
      const w = this.waiting.get(id)
      this.waiting.delete(id)
      w?.ok(reply)
    })
    wc.on('render-process-gone', (_e, details) => this.fail(new Error(`The 3D page stopped (${details.reason}).`)))
    this.win.on('closed', () => this.fail(new Error('The 3D page closed.')))
    const loaded =
      is.dev && process.env['ELECTRON_RENDERER_URL']
        ? this.win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/three.html`)
        : this.win.loadFile(join(__dirname, '../renderer/three.html'))
    loaded.catch((err: Error) => failed(new Error(`The 3D page did not open: ${err.message}`)))
    this.failReady = failed
  }

  private failReady: (e: Error) => void

  private fail(err: Error): void {
    if (this.gone) return
    this.gone = err
    this.failReady(err)
    for (const w of this.waiting.values()) w.fail(err)
    this.waiting.clear()
  }

  /** Sends a message and waits for its answer; an answer that says no throws its reason. */
  async ask(message: HostAsk): Promise<HostReply & { ok: true }> {
    await this.ready
    if (this.gone) throw this.gone
    const id = this.next++
    const reply = await new Promise<HostReply>((ok, fail) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        fail(new Error(`The 3D page did not answer a ${message.kind} in time.`))
      }, ANSWER_MS)
      this.waiting.set(id, {
        ok: (r) => {
          clearTimeout(timer)
          ok(r)
        },
        fail: (e) => {
          clearTimeout(timer)
          fail(e)
        }
      })
      this.win.webContents.send('scene3d', { ...message, id })
    })
    if (!reply.ok) throw new Error(`The 3D page could not draw: ${reply.error}`)
    return reply
  }

  close(): void {
    this.fail(new Error('The 3D page was closed.'))
    if (!this.win.isDestroyed()) this.win.destroy()
  }
}

interface Held {
  key: string
  canvas: Canvas
  shown: boolean
  /** Its video cards, as layers the video decoder reads. */
  cards: { object: string; layer: VideoLayer }[]
}

/** A 3D layer's name in the page: its clip and where it plays, since a split clip's halves share nothing. */
const keyOf = (layer: Scene3DLayer): string => `${layer.id ?? '3d'}@${layer.start.toFixed(4)}`

async function readCapped(path: string): Promise<Uint8Array | null> {
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null
    return new Uint8Array(await fs.readFile(path))
  } catch {
    return null
  }
}

/** A link in a file's place is never fetched: the export makes no requests. */
const isLink = (src: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(src)

export function scene3dFrames(opts: Scene3DFramesOptions): Scene3DFrames {
  let host: Host | null = null
  const held = new Map<string, Held>()
  const sentFaces = new Set<string>()
  const sizes = new Map<string, { width: number; height: number }>()
  const videos: VideoFrames = videoFrames(opts.ffmpeg, opts.fps, sizes)
  let closed = false

  const close = (): void => {
    if (closed) return
    closed = true
    videos.close()
    host?.close()
    host = null
    held.clear()
  }
  opts.signal?.addEventListener('abort', close, { once: true })

  const open = (): Host => {
    if (closed) throw new Error('The export was cancelled.')
    host ??= new Host()
    return host
  }

  /** Sends a clip's scene and the files it shows, once. */
  async function setUp(layer: Scene3DLayer): Promise<Held> {
    const page = open()
    const faces = new Set<string>()
    for (const o of layer.scene.objects)
      if ((o.type === 'text' && o.text) || (o.type === 'card' && o.title)) faces.add(fontInfo(o.font ?? TITLE_3D_FACE).family)
    const newFaces: { family: string; bytes: Uint8Array }[] = []
    for (const family of faces) {
      if (sentFaces.has(family) || !opts.fontsDir) continue
      sentFaces.add(family)
      const bytes = await readCapped(join(opts.fontsDir, fontInfo(family).file))
      if (bytes) newFaces.push({ family, bytes })
      else console.warn(`[3d] no ${family} in ${opts.fontsDir}`)
    }
    if (newFaces.length) await page.ask({ kind: 'faces', faces: newFaces })

    const pictures: { src: string; bytes: Uint8Array }[] = []
    const models: { src: string; bytes: Uint8Array }[] = []
    const cards: Held['cards'] = []
    const key = keyOf(layer)
    for (const o of layer.scene.objects) {
      if (!o.src || isLink(o.src)) continue
      if (o.type === 'model' && isModelFile(o.src)) {
        const bytes = await readCapped(o.src)
        if (bytes) models.push({ src: o.src, bytes })
      } else if (o.type === 'card' && isVideoFile(o.src)) {
        if (!sizes.has(o.src)) {
          const facts = await videoFacts(opts.ffmpeg, o.src)
          if (facts) {
            const k = Math.min(1, VIDEO_CARD_PX / Math.max(facts.width, facts.height))
            sizes.set(o.src, decodeSize(facts, { width: facts.width * k, height: facts.height * k }))
          }
        }
        cards.push({ object: o.id, layer: cardLayer(key, o, layer) })
      } else if (o.type === 'card' && !pictures.some((p) => p.src === o.src)) {
        const bytes = await readCapped(o.src)
        if (bytes) pictures.push({ src: o.src, bytes })
      }
    }
    await page.ask({ kind: 'clip', clip: key, scene: layer.scene, design: { width: layer.w, height: layer.h }, pixels: opts.pixels, pictures, models })
    const h: Held = { key, canvas: createCanvas(opts.pixels.width, opts.pixels.height), shown: false, cards }
    held.set(key, h)
    return h
  }

  return {
    async prepare(t, layers) {
      if (opts.signal?.aborted || closed) throw new Error('The export was cancelled.')
      const on = new Set<string>()
      for (const layer of layers) if (t >= layer.start && t < layer.end) on.add(keyOf(layer))
      // What has ended is let go of first, here and in the page.
      for (const [key, h] of held) {
        if (on.has(key)) continue
        held.delete(key)
        if (h.cards.length) await videos.prepare(Number.POSITIVE_INFINITY, h.cards.map((c) => c.layer))
        if (host) await host.ask({ kind: 'drop', clip: key })
      }
      for (const layer of layers) {
        if (!on.has(keyOf(layer))) continue
        const h = held.get(keyOf(layer)) ?? (await setUp(layer))
        const frames: { object: string; data: Uint8Array; width: number; height: number }[] = []
        if (h.cards.length) {
          await videos.prepare(t, h.cards.map((c) => c.layer))
          for (const c of h.cards) {
            const img = videos.frame(c.layer, t - layer.start) as unknown as Canvas | null
            if (!img) continue
            const px = img.getContext('2d').getImageData(0, 0, img.width, img.height).data
            frames.push({ object: c.object, data: new Uint8Array(px.buffer, px.byteOffset, px.byteLength), width: img.width, height: img.height })
          }
        }
        const r = await open().ask({ kind: 'frame', clip: h.key, local: t - layer.start, length: layer.end - layer.start, videos: frames, shutter: shutterFor(opts.fps) })
        if (!r.data || !r.width || !r.height) continue
        const data = new Uint8ClampedArray(r.data.buffer, r.data.byteOffset, r.data.byteLength)
        h.canvas.getContext('2d').putImageData(new ImageData(data, r.width, r.height), 0, 0)
        h.shown = true
      }
    },
    frame(layer) {
      const h = held.get(keyOf(layer))
      return h?.shown ? (h.canvas as unknown as CanvasImageSource) : null
    },
    close
  }
}

/** A video card as a layer the video decoder reads: its file from where it starts, while the clip plays. */
function cardLayer(key: string, o: Object3D, layer: Scene3DLayer): VideoLayer {
  return { kind: 'video', id: `${key}:${o.id}`, src: o.src as string, in: o.in ?? 0, speed: 1, start: layer.start, end: layer.end, w: 1, h: 1 }
}
