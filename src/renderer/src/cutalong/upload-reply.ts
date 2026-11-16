import { titlesText, uploadMessage, uploadSetMessage, type UploadKit } from '../../../shared/upload'
import type { Msg } from './components/Message'

/**
 * The reply under an export that says what is ready for the upload: a
 * sentence and three facts, the titles, description, tags and files behind
 * Details, and buttons to copy the description and the titles and to show
 * the files.
 */
export function uploadReply(kit: UploadKit): Omit<Msg, 'id'> {
  const m = uploadMessage(kit)
  return {
    role: 'assistant',
    text: m.text,
    chips: m.chips,
    details: m.details,
    aside: m.aside,
    actions: [
      { kind: 'copy', label: 'Copy the description', payload: kit.description, primary: true },
      { kind: 'copy', label: 'Copy the titles', payload: titlesText(kit) },
      { kind: 'reveal', label: 'Show the files', payload: kit.files.description }
    ]
  }
}

/**
 * One reply for many exports at once (/clipping's Export all), however many
 * there are: a sentence, each one's titles behind Details, and the files.
 * One export keeps its own reply.
 */
export function uploadSetReply(kits: { name: string; kit: UploadKit }[]): Omit<Msg, 'id'> {
  if (kits.length === 1) return uploadReply(kits[0].kit)
  const m = uploadSetMessage(kits)
  return {
    role: 'assistant',
    text: m.text,
    details: m.details,
    aside: m.aside,
    actions: [{ kind: 'reveal', label: 'Show the files', payload: kits[0].kit.files.description }]
  }
}
