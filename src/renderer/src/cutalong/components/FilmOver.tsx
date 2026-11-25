import { useEffect, useRef } from 'react'
import { outputRate } from '../../../../shared/fx/apply'
import { drawFilmFine, drawFilmSoft, filmFrame, filmLayers, softSize, type FilmCanvas, type FilmLook } from '../../../../shared/edit/film'

/** The export's frame rates: 29.97 plays as 30 (main/cut-render.ts frameRate). */
export function filmFps(fps: number): number {
  return outputRate(fps)
}

/**
 * Old film over the preview: the same frame of dust, hairs, scratches, leaks
 * and flicker the export lays over the picture at this moment, drawn by the
 * same functions (shared/edit/film.ts), the soft layer small and scaled up as
 * the export scales it. Under the captions and the graphics, as in the export.
 */
export function FilmOver({ look, time, fps, width, height }: { look: FilmLook; time: number; fps: number; width: number; height: number }): JSX.Element | null {
  const fine = useRef<HTMLCanvasElement>(null)
  const soft = useRef<HTMLCanvasElement>(null)
  const layers = filmLayers(look)
  const frame = filmFrame(time, fps)
  const w = Math.max(2, Math.round(width))
  const h = Math.max(2, Math.round(height))
  const small = softSize(w, h)
  useEffect(() => {
    const f = fine.current?.getContext('2d')
    if (f) {
      f.clearRect(0, 0, w, h)
      drawFilmFine(f as unknown as FilmCanvas, w, h, look, frame, fps)
    }
    const s = soft.current?.getContext('2d')
    if (s) {
      s.clearRect(0, 0, small.width, small.height)
      drawFilmSoft(s as unknown as FilmCanvas, small.width, small.height, look, frame, fps)
    }
  }, [frame, fps, h, look, small.height, small.width, w])
  if (!layers.fine && !layers.soft) return null
  return (
    <>
      {layers.soft && <canvas ref={soft} className="cl-film" width={small.width} height={small.height} aria-hidden="true" />}
      {layers.fine && <canvas ref={fine} className="cl-film" width={w} height={h} aria-hidden="true" />}
    </>
  )
}
