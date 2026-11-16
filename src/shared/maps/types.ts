import type { GeoBox, LonLat } from './mercator'

/**
 * What a map layer holds: everything the drawing needs to paint any moment
 * of the shot, as plain data. Geography is named, not copied (a country by
 * its id, a plate boundary by its plates), and the drawing finds the shapes
 * in the map data both the editor and the export load, so the layer stays
 * small and the two draw the same thing.
 *
 * Times are seconds from the layer's start.
 */

export const MAP_STYLES = ['satellite-dark', 'vintage'] as const
export type MapStyle = (typeof MAP_STYLES)[number]

/** A camera stop: it arrives framing a box, holds while pushing in a little, and leaves. */
export interface MapStop {
  arrive: number
  leave: number
  box: GeoBox
  /** Zoom levels added over the hold, so the frame never sits dead. */
  push: number
  /** Frames this stretch of plate boundary as the plate data draws it, when it is there; `box` otherwise. */
  fitBoundary?: { pairs: [string, string][]; window: GeoBox }
}

/** When something shows: it comes in at `from` and goes at `to`. */
export interface Span {
  from: number
  to: number
}

/** A rectangle in design pixels. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Shapes from the map data, by id. */
export type AreaRef =
  | { country: string }
  | { state: string }
  | { plate: string }
  /** Several countries lit as one: a region. */
  | { countries: string[] }

export type LineRef =
  /** PB2002 boundaries between these plate pairs, inside a window. */
  | { boundary: { pairs: [string, string][]; window: GeoBox } }
  /** A parallel, dotted across the map. */
  | { lat: number }
  /** From one place to another, bowed like a flight path, with an arrow at the end. */
  | { route: [LonLat, LonLat] }
  /** A path through points. */
  | { points: LonLat[] }

export type MapFeature =
  | {
      type: 'area'
      ref: AreaRef
      show: Span
      /** Lit in the accent (the subject) or quietly (a neighbour, a plate behind a line). */
      tone: 'accent' | 'quiet'
    }
  | {
      type: 'line'
      ref: LineRef
      show: Span
      /** A ridge or boundary glows; a route is a dashed path with an arrow; a parallel is dotted. */
      look: 'ridge' | 'route' | 'parallel'
      /** Set along the line, as it runs. */
      label?: string
    }
  | { type: 'pin'; at: LonLat; label: string; show: Span; major: boolean }
  | {
      type: 'label'
      text: string
      /** A point, or the middle of a plate's land in view. */
      at: LonLat | { plate: string }
      show: Span
      /** A country or region beside the subject, a plate, or a sea. */
      look: 'neighbour' | 'plate' | 'water'
    }

export interface MapPaint {
  style: MapStyle
  /** The highlight's colour. */
  accent: string
  /** Where the camera starts, before the first stop: the whole world or a box. */
  open: GeoBox | 'world'
  stops: MapStop[]
  features: MapFeature[]
  /** Where the map is drawn: the whole frame, or a card for an inset, with its corner radius. */
  viewport: Rect & { radius: number }
  /** Kept clear of what a stop frames, in design pixels from the viewport's edges: the title's side is wider. */
  pad: { top: number; right: number; bottom: number; left: number }
  /** Kept clear of labels: the title's block. */
  reserve: Rect[]
}
