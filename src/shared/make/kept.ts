import { addAsset, commit, currentCut, currentVersion, type Asset, type EditDoc, type Op } from '../edit'
import { stampMade } from '../brands'
import { clipOfDoc, withDoc } from '../clipping/set'
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

/** Whether a kept result is a new made video, which never takes the place of an edit. */
export const freshVideo = (kept: Kept): boolean => !!kept.doc && !kept.into

/** Said with a shot made again for a video no longer in its chat: where the picture it paid for is. */
export const shotKeptAt = (path: string): string =>
  `The video it was made for isn’t in this chat any more, so it went into no edit; the picture is kept at ${path}.`

/**
 * A shot made again, as the next version of the edit it was made for, with what the brand never uses left out, and
 * the made video's record as it now is. The version made, or null when the shot changed nothing in the cut.
 */
export function shotInto(x: EditDoc, shot: NonNullable<Kept['shot']>, never: NeverItem[]): { doc: EditDoc; version: number | null } {
  const added = addAsset(x, shot.asset).doc
  const guarded = neverGuard(currentCut(added), shot.ops, never, { words: added.words, sources: added.sources, assets: added.assets })
  const next = commit(added, guarded.ops, shot.summary).doc
  return { doc: { ...next, make: shot.make }, version: next !== added ? currentVersion(next).n : null }
}

/** The edit a change or a shot was made for, by its id: the chat's own edit, or one of its clips. */
export function editIn(project: Project, docId: string): EditDoc | null {
  if (project.edit?.id === docId) return project.edit
  return clipOfDoc(project.clipping, docId)?.doc ?? null
}

/**
 * The chat's file with a kept result in it, as it would have landed had the chat been open: the reply at the end
 * of its chat, a new made video as its edit, made in its brand, a change of a made video as the next version of
 * the edit it was made for, and a shot made again likewise, with what the brand never uses left out. That edit is
 * found by its id, the chat's own or one of its clips, whichever is open. Nothing paid for is left out: a new made
 * video never replaces an edit the chat already has, and a change made for an edit no longer in the chat has none
 * to go into, so either way nothing is written here (null) and it goes in a chat of its own; a shot with no edit to
 * go into is said, with where its picture is kept.
 */
export function keepInProject(project: Project, kept: Kept, id: string): Project | null {
  const edit: EditDoc | null = project.edit ?? null
  let placed: EditDoc | null = null
  let text = kept.message.text
  if (kept.doc) {
    if (kept.into) {
      const x = editIn(project, kept.into.docId)
      if (!x) return null
      placed = asNewVersion(x, kept.doc, kept.into.summary, kept.into.carry)
      text = renumber(text, currentVersion(placed).n)
    } else if (edit && edit.id !== kept.doc.id) return null
    else placed = edit ? kept.doc : stampMade(kept.doc, kept.brand)
  }
  if (kept.shot) {
    const x = editIn(project, kept.shot.doc)
    if (x) {
      const made = shotInto(x, kept.shot, kept.never)
      if (made.version) text = `v${made.version} is ready. ${text}`
      placed = made.doc
    } else text = `${text} ${shotKeptAt(kept.shot.asset.path)}`
  }
  // A shot in no edit offers nothing to open.
  const nowhere = !!kept.shot && !placed
  const message: ChatMessage = { ...kept.message, id, text, ...(nowhere ? { actions: [] } : {}) }
  return withDoc({ ...project, chat: [...(project.chat ?? []), message] }, placed)
}
