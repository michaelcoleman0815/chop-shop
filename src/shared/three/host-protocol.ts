import type { Size } from '../motion/types'
import type { Scene3D } from './spec'

/**
 * What the export's main process and its 3D page (renderer/three.html) say
 * to each other (main/three-render.ts, renderer/src/three-host.ts). Every
 * message carries an id the page answers with; the page says it is ready by
 * answering id 0 before anything is sent. Everything the page draws arrives
 * as bytes, so it reads no file and fetches nothing.
 */
export type HostMessage =
  /** Bundled faces, by family: for extruded titles and a card's words. */
  | { id: number; kind: 'faces'; faces: { family: string; bytes: Uint8Array }[] }
  /** A 3D clip to draw: its scene, its pictures' and models' files as bytes, keyed by the src that names them. */
  | {
      id: number
      kind: 'clip'
      clip: string
      scene: Scene3D
      design: Size
      pixels: Size
      pictures: { src: string; bytes: Uint8Array }[]
      models: { src: string; bytes: Uint8Array }[]
    }
  /** A frame of a clip, `local` seconds in, with its video cards' frames for that moment as RGBA. */
  | {
      id: number
      kind: 'frame'
      clip: string
      local: number
      length: number
      videos: { object: string; data: Uint8Array; width: number; height: number }[]
      /** Seconds across which a moving scene is averaged, a camera's shutter (shutterFor); sharp when absent. */
      shutter?: number
    }
  /** A clip that has ended: everything it held is let go. */
  | { id: number; kind: 'drop'; clip: string }

/** A frame comes back as straight (not premultiplied) RGBA, `width` by `height`. */
export type HostReply = { ok: true; data?: Uint8Array; width?: number; height?: number } | { ok: false; error: string }

/** A message without its id, as the main process writes one before it is numbered. */
export type HostAsk = HostMessage extends infer M ? (M extends { id: number } ? Omit<M, 'id'> : never) : never

export interface HostBridge {
  on(listener: (message: HostMessage) => void): void
  reply(id: number, value: HostReply): void
}
