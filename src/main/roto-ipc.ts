import { ipcMain } from 'electron'
import { applyOps, currentCut, EditDocSchema } from '../shared/edit'
import { followClips, type Followed } from './clip-follow'
import { FFMPEG_PATH } from './ffmpeg'
import { trackObject } from './track'
import { videoFacts } from './video-frames'

/**
 * The editor's half of following: every clip and mask the edit asks to
 * follow an object (with the ops that ask it, not yet applied), followed by
 * Vision (main/clip-follow), handed back as the ops that put their paths on,
 * for the editor to apply with the asking ops as one change.
 */
export function registerRotoIpc(): void {
  ipcMain.handle('layers:follow', async (_e, req: { doc: unknown; ops?: unknown[] }): Promise<Followed> => {
    const parsed = EditDocSchema.safeParse(req.doc)
    if (!parsed.success) return { ops: [], said: 'That edit could not be read, so nothing was followed.' }
    const doc = parsed.data
    // The ops that ask to follow, as the editor is about to apply them with what is found.
    const asked = applyOps(currentCut(doc), Array.isArray(req.ops) ? req.ops : [], doc).cut
    return followClips(asked, doc, trackObject, async (file) => {
      const facts = await videoFacts(FFMPEG_PATH, file)
      return facts && facts.height > 0 ? facts.width / facts.height : null
    })
  })
}
