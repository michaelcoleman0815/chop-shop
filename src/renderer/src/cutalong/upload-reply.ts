import { titlesText, uploadMessage, type UploadKit } from '../../../shared/upload'
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
