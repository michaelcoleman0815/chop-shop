import type { FilmFiles } from '../../../src/main/render/film'
import { filmLayers, type FilmLook } from '../../../src/shared/edit/film'
import { ON_THE_MAC } from '../host/limits'

/**
 * Film's dust, light leaks and flicker as the phone's page sees them. The
 * export draws them on the Mac's Skia (src/main/render/film.ts), which a
 * phone does not have, so they are on the Mac for now (host/limits.ts) and an
 * export with any is refused before it starts (host/api.ts, phoneWork). Gate
 * weave is a filter of ffmpeg's own and needs no layer, so a look with weave
 * alone renders here.
 */
export async function renderFilm(look: FilmLook): Promise<FilmFiles> {
  const layers = filmLayers(look)
  if (layers.fine || layers.soft) throw new Error(ON_THE_MAC.film)
  return { fine: null, soft: null }
}
