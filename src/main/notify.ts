import { BrowserWindow, Notification } from 'electron'
import type { NoteAnswer, NoteIn } from '../shared/types'

/**
 * A note from Cutalong when long work finishes while you are in another app:
 * "v3 of Google Book review is ready", with Export and Watch. Asked for under
 * the work in the chat (the renderer's notify.ts), and only sent while the
 * window is not in front. A click brings the window back and opens the edit;
 * a button says which it was. macOS shows the buttons when Cutalong's
 * notifications are set to Alerts, and the click either way.
 */
/** Kept until answered or closed, so macOS does not drop the notification and its buttons with it. */
const live = new Set<Notification>()

export function showNote(win: BrowserWindow | null, note: NoteIn): boolean {
  if (!Notification.isSupported()) return false
  const n = new Notification({
    title: note.title,
    body: note.body,
    silent: false,
    actions: note.actions.slice(0, 2).map((text) => ({ type: 'button' as const, text }))
  })
  const answer = (a: NoteAnswer): void => {
    live.delete(n)
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send('notify:answer', a)
    }
  }
  n.on('click', () => answer('open'))
  n.on('action', (_e, index) => answer(index))
  n.on('close', () => live.delete(n))
  live.add(n)
  n.show()
  return true
}
