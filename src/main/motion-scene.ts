import { captionedWords, type Asset, type Cut, type Resolved, type Source, type Word } from '../shared/edit'
import {
  buildScene,
  drawsCaptions,
  themeFrom,
  type BrandLook,
  type FaceSample,
  type IconNode,
  type LogoMark,
  type MotionScene
} from '../shared/motion'
import { frameSize } from './cut-render'

/**
 * The scene a cut's graphics make, and what the subtitle pass leaves to them:
 * pure, so every host renders the same cut the same way. Drawing the
 * graphics (motion-render.ts) needs a canvas the Mac has; these do not.
 */

export interface CutMotionInput {
  cut: Cut
  resolved: Resolved
  words: Word[]
  sources: Source[]
  assets: Asset[]
  brand: BrandLook | null
  quality: 'preview' | 'final'
  ffmpeg: string
  workDir: string
  fontsDir: string | null
  /** Loads icon shapes, only when a graphic draws one. */
  icons?: () => Promise<(name: string) => IconNode[] | undefined>
  /** Loads brand marks, only when a graphic draws one. */
  logos?: () => Promise<(slug: string) => LogoMark | undefined>
  /** Faces through the cut, from face tracking, for drawn captions to keep off. */
  faces?: FaceSample[]
  /** How strongly each word is stressed, 0 to 1, by word id. */
  emphasis?: Record<string, number>
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

/** The scene a cut's graphics make, laid out in the full-size frame. */
export function sceneForCut(
  input: Pick<CutMotionInput, 'cut' | 'resolved' | 'words' | 'sources' | 'brand' | 'faces' | 'emphasis'> & {
    assets?: CutMotionInput['assets']
  }
): MotionScene {
  const first = input.sources.find((s) => s.id === input.resolved.pieces[0]?.source) ?? input.sources[0]
  return buildScene({
    cut: input.cut,
    resolved: input.resolved,
    words: input.words,
    size: frameSize(input.cut.aspect, first),
    theme: themeFrom(input.brand),
    faces: input.faces,
    emphasis: input.emphasis,
    assets: input.assets
  })
}

/**
 * The cut the picture and subtitle pass renders: when the graphics draw the
 * captions, the subtitle pass leaves them out, so they are not drawn twice.
 */
export function subtitleCut(cut: Cut): Cut {
  return drawsCaptions(cut.captions) ? { ...cut, captions: { ...cut.captions, on: false } } : cut
}

/**
 * What the picture and subtitle pass renders: subtitleCut's cut, and the
 * words said while a card holds the screen (an end card, a title quoting the
 * speech) left out of the subtitles, as drawn captions wait for them too.
 * Only the subtitles read the words, so the picture is unchanged.
 */
export function subtitlePass(cut: Cut, resolved: Resolved, scene: MotionScene): { cut: Cut; resolved: Resolved } {
  // What covers the screen is the graphic's own say: a full-frame map holds the captions, a map inset does not.
  const cards = scene.items.filter((i) => i.covers === 'card')
  // Beats whose captions are off are left out too.
  const words = captionedWords(cut, resolved).words.filter(
    (w) => !cards.some((c) => w.outEnd > c.start && w.outStart < c.end)
  )
  return {
    cut: subtitleCut(cut),
    resolved: words.length === resolved.words.length ? resolved : { ...resolved, words }
  }
}
