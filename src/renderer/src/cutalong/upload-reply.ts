import { titlesText, uploadMessage, uploadSetMessage, type UploadKit } from '../../../shared/upload'
import { device } from './api'
import type { Msg } from './components/Message'

/**
 * Where the kit was made, when it is not the Mac the shared sentences name. Read when a reply is made, not when
 * this loads: a window's test may stand in for the API without a device and still load what imports this.
 */
const here = (): string | undefined => (device.kind === 'phone' ? device.here : undefined)

/** Show the files, where the device has a place to show them (a phone keeps them in the app). */
const showFiles = (path: string): NonNullable<Msg['actions']> =>
  device.reveal ? [{ kind: 'reveal', label: 'Show the files', payload: path }] : []

/**
 * The reply under an export that says what is ready for the upload: a
 * sentence and three facts, the titles, description, tags and files behind
 * Details, and buttons to copy the description and the titles and to show
 * the files.
 */
export function uploadReply(kit: UploadKit): Omit<Msg, 'id'> {
  const m = uploadMessage(kit, here())
  return {
    role: 'assistant',
    text: m.text,
    chips: m.chips,
    details: m.details,
    aside: m.aside,
    actions: [
      { kind: 'copy', label: 'Copy the description', payload: kit.description, primary: true },
      { kind: 'copy', label: 'Copy the titles', payload: titlesText(kit) },
      ...showFiles(kit.files.description)
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
  const m = uploadSetMessage(kits, here())
  const actions = showFiles(kits[0].kit.files.description)
  return {
    role: 'assistant',
    text: m.text,
    details: m.details,
    aside: m.aside,
    ...(actions.length ? { actions } : {})
  }
}
