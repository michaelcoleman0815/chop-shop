import { addAsset, commit, currentCut, currentVersion, type Asset, type EditDoc, type Op } from '../../../shared/edit'
import { stampMade } from '../../../shared/brands'
import { withDoc } from '../../../shared/clipping/set'
import { asNewVersion } from '../../../shared/make/assemble'
import type { Draft } from '../../../shared/make/draft'
import type { Make } from '../../../shared/make/schema'
import { neverGuard, type NeverItem } from '../../../shared/never'
import type { ChatMessage, Project } from '../../../shared/types'

/**
 * What a paid piece of work brought back for a chat that is not the one open
 * (useMake), to keep in that chat's own file: the reply as that chat shows
 * it, and a made video as its edit (or, `into`, a new version of it), or a
 * shot made again as a new version of the edit it was quoted on. It is never
 * put into the chat open.
 */
export interface Kept {
  message: Omit<ChatMessage, 'id'>
  doc?: EditDoc
  into?: Draft['into'] | null
  shot?: { doc: string; asset: Omit<Asset, 'id'>; ops: Op[]; make: Make; summary: string }
}

/** The reply's version number made the one committed. */
export const renumber = (text: string, n: number): string => text.replace(/^v\d+\b/, `v${n}`)

/** Said instead, when the chat's edit changed before the result came back and it no longer fits. */
const CHANGED = 'This chat’s edit changed before it came back, so I left it out of it.'

/**
 * The chat's file with a kept result in it, as it would have landed had the chat been open: the reply at the end
 * of its chat, a new made video as its edit, made in its brand, a change of a made video as that edit's next
 * version, and a shot made again as the next version of the edit it was made for, with what the brand never
 * uses left out. `brand` is the chat's own brand; `never` what it never uses.
 */
export function keepInProject(project: Project, kept: Kept, opts: { id: string; brand: string; never: NeverItem[] }): Project {
  let edit: EditDoc | null = project.edit ?? null
  let text = kept.message.text
  let error = kept.message.error
  if (kept.doc) {
    if (kept.into) {
      if (edit && edit.id === kept.into.docId) {
        edit = asNewVersion(edit, kept.doc, kept.into.summary, kept.into.carry)
        text = renumber(text, currentVersion(edit).n)
      } else {
        text = CHANGED
        error = true
      }
    } else edit = edit?.id === kept.doc.id ? kept.doc : stampMade(kept.doc, opts.brand)
  }
  if (kept.shot) {
    if (edit && edit.id === kept.shot.doc) {
      const added = addAsset(edit, kept.shot.asset).doc
      const guarded = neverGuard(currentCut(added), kept.shot.ops, opts.never, {
        words: added.words,
        sources: added.sources,
        assets: added.assets
      })
      const next = commit(added, guarded.ops, kept.shot.summary).doc
      if (next !== added) text = `v${currentVersion(next).n} is ready. ${text}`
      edit = { ...next, make: kept.shot.make }
    } else {
      text = CHANGED
      error = true
    }
  }
  // Left out, it offers nothing to open.
  const message: ChatMessage = { ...kept.message, id: opts.id, text, ...(error ? { error: true, actions: [] } : {}) }
  return withDoc({ ...project, chat: [...(project.chat ?? []), message] }, edit)
}
