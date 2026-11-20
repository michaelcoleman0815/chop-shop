import { addAsset, commit, currentCut, currentVersion, type Asset, type EditDoc, type Op } from '../edit'
import { stampMade } from '../brands'
import { withDoc } from '../clipping/set'
import { asNewVersion } from './assemble'
import type { Draft } from './draft'
import type { Make } from './schema'
import { neverGuard, type NeverItem } from '../never'
import type { ChatMessage, Project } from '../types'

/**
 * What a paid piece of work brought back for a chat that is not the one open
 * (useMake), to keep in that chat's own file: the reply as that chat shows
 * it, and a made video as its edit (or, `into`, a new version of it), or a
 * shot made again as a new version of the edit it was quoted on. It is never
 * put into the chat open. `brand` is the brand of the chat it was asked in,
 * and `never` what that brand never uses.
 */
export interface Kept {
  message: Omit<ChatMessage, 'id'>
  doc?: EditDoc
  into?: Draft['into'] | null
  shot?: { doc: string; asset: Omit<Asset, 'id'>; ops: Op[]; make: Make; summary: string }
  brand: string
  never: NeverItem[]
}

/** The reply's version number made the one committed. */
export const renumber = (text: string, n: number): string => text.replace(/^v\d+\b/, `v${n}`)

/** Said instead, when the chat's edit changed before the result came back and it no longer fits. */
const CHANGED = 'This chat’s edit changed before it came back, so I left it out of it.'

/** Whether a kept result is a new made video, which never takes the place of an edit. */
export const freshVideo = (kept: Kept): boolean => !!kept.doc && !kept.into

/**
 * The chat's file with a kept result in it, as it would have landed had the chat been open: the reply at the end
 * of its chat, a new made video as its edit, made in its brand, a change of a made video as that edit's next
 * version, and a shot made again as the next version of the edit it was made for, with what the brand never
 * uses left out. A new made video never replaces an edit the chat already has, the person's own footage or
 * another made video: then nothing is written (null), and it goes in a chat of its own.
 */
export function keepInProject(project: Project, kept: Kept, id: string): Project | null {
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
    } else if (edit && edit.id !== kept.doc.id) return null
    else edit = edit ? kept.doc : stampMade(kept.doc, kept.brand)
  }
  if (kept.shot) {
    if (edit && edit.id === kept.shot.doc) {
      const added = addAsset(edit, kept.shot.asset).doc
      const guarded = neverGuard(currentCut(added), kept.shot.ops, kept.never, {
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
  const message: ChatMessage = { ...kept.message, id, text, ...(error ? { error: true, actions: [] } : {}) }
  return withDoc({ ...project, chat: [...(project.chat ?? []), message] }, edit)
}
