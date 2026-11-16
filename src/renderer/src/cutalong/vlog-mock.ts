import { currentCut, currentVersion, resolveCut, type EditDoc } from '../../../shared/edit'
import { extendShoot } from '../../../shared/vlog/build'
import { carryTold, opsFor, planLocally, vlogShown, withOps } from '../../../shared/vlog/plan'
import { pretendVlog } from '../../../shared/vlog/pretend'
import { storyReply } from '../../../shared/vlog/reply'
import { parseVlogAsk } from '../../../shared/vlog/request'
import type { CutalongApi } from './api'

/**
 * The browser mock's vlog: a day of clips it pretends to have watched
 * (shared/vlog/pretend), cut by the same shared logic the app uses.
 */

export function mockVlogApi(progress: (stage: string) => Promise<void>): Pick<CutalongApi, 'makeVlog' | 'planVlog'> {
  return {
    makeVlog: async ({ paths, request, doc }) => {
      if (doc && !doc.vlog)
        return { ok: false as const, message: 'This preview makes vlogs only from clips dropped into a new chat.' }
      const earlier = doc?.vlog?.clips.map((c) => c.path) ?? []
      const all = [...new Set([...earlier, ...paths])].filter((p) => !/\.(mp3|m4a|wav|aiff?)$/i.test(p))
      if (all.length === 0) return { ok: false as const, message: 'None of those has a picture I could read.' }
      for (let n = 0; n < all.length; n += Math.max(1, Math.ceil(all.length / 4)))
        await progress(`Watching your clips (${Math.min(all.length, n + 1)} of ${all.length})`)
      await progress('Looking at your moments')
      await progress('Putting the story together')
      const made = pretendVlog(all, { keep: doc ?? undefined, request })
      if (!doc?.vlog) return { ok: true as const, doc: made.doc, mediaUrl: '/sample.mp4', reply: made.reply }
      // More clips for the vlog under way: they join it, and the story is told again as a new version.
      const known = new Set(doc.sources.map((s) => s.id))
      const added = made.doc.sources.filter((s) => !known.has(s.id))
      const grown = extendShoot(
        doc,
        { sources: added, words: made.doc.words.filter((w) => !known.has(w.source)), removed: [] },
        { ...made.vlog, told: carryTold(doc.vlog, made.vlog) },
        `${added.length} more clips are in the story.`
      )
      const reply = storyReply(grown, made.vlog, {
        version: currentVersion(grown).n,
        previousSec: resolveCut(currentCut(doc), doc.words, doc.sources).durationSec,
        added: added.length
      })
      return { ok: true as const, doc: grown, mediaUrl: '/sample.mp4', reply }
    },
    planVlog: async ({ doc, request }) => {
      await progress('Telling the story again')
      const shown = vlogShown(doc)
      if (!shown)
        return { ok: false as const, message: 'This edit was not cut from a shoot, so it has no story to change.' }
      const planned = planLocally(doc, shown, parseVlogAsk(request))
      const vlog = { ...shown, story: planned.story }
      const ops = opsFor(doc, planned.story.beats)
      const preview: EditDoc = withOps({ ...doc, vlog }, ops)
      const reply = storyReply(preview, vlog, {
        version: currentVersion(doc).n + 1,
        previousSec: resolveCut(currentCut(doc), doc.words, doc.sources).durationSec
      })
      return { ok: true as const, ops, vlog, reply, by: 'rules' as const }
    }
  }
}
