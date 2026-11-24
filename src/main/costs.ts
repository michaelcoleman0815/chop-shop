import { app, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import {
  chatCost,
  claimLoose,
  emptyLedger,
  entryFor,
  readLedger,
  record,
  summarise,
  type ChatShape,
  type CostLedger,
  type CostSummary,
  type ProjectRef
} from '../shared/costs'
import type { Project } from '../shared/types'
import { setUsageSink } from './usage'

/**
 * The ledger of what each chat has cost (shared/costs), in userData as
 * costs.json: one line a paid call, under the chat that was open when it
 * went. The window says which chat is open (`costs:open`); a call made with
 * none open waits as loose for the chat it starts. The ledger is a record of
 * what was spent, not part of the work, so nothing here ever stops a call or
 * a save, and losing the file loses only the record.
 */

const ledgerPath = (): string => join(app.getPath('userData'), 'costs.json')

let ledger: CostLedger | null = null
let open: ProjectRef | null = null
let writing: Promise<void> = Promise.resolve()

async function load(): Promise<CostLedger> {
  if (ledger) return ledger
  try {
    ledger = readLedger(JSON.parse(await fs.readFile(ledgerPath(), 'utf8')))
  } catch {
    ledger = emptyLedger()
  }
  return ledger
}

/** Writes the ledger after any write before it, through a file of its own so a crash never leaves half of one. */
function persist(): Promise<void> {
  writing = writing
    .then(async () => {
      if (!ledger) return
      const file = ledgerPath()
      await fs.writeFile(`${file}.tmp`, JSON.stringify(ledger))
      await fs.rename(`${file}.tmp`, file)
    })
    .catch((err) => console.error('[costs] could not write the ledger:', err instanceof Error ? err.message : err))
  return writing
}

/** One change to the ledger: read and applied with no wait between, so two calls coming back together both land. */
async function change(fn: (l: CostLedger) => CostLedger): Promise<void> {
  await load()
  const before = ledger as CostLedger
  const after = fn(before)
  if (after === before) return
  ledger = after
  await persist()
}

/** The chat open in the window now, or null on Start: calls from here on are written against it. */
export async function setOpenChat(ref: ProjectRef | null): Promise<void> {
  open = ref ? { id: String(ref.id), name: String(ref.name ?? ''), path: ref.path ? String(ref.path) : null } : null
  if (open) {
    const to = open
    await change((l) => claimLoose(l, to, new Date()))
  }
}

/** A chat was saved: its name and place, so the summary can find it again. */
export async function noteSaved(project: Pick<Project, 'id' | 'name' | 'path'>): Promise<void> {
  await change((x) => {
    const had = x.projects[project.id]
    if (!had || (had.name === project.name && had.path === project.path)) return x
    return { ...x, projects: { ...x.projects, [project.id]: { ...had, name: project.name, path: project.path } } }
  })
}

async function shapeOf(path: string | null): Promise<(ChatShape & { id?: string }) | null> {
  if (!path) return null
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as ChatShape & { id?: string }
  } catch {
    return null
  }
}

/** What one chat has cost so far: its calls, and what a video made from nothing spent on its own. */
export async function costOfChat(id: string, path: string | null): Promise<number> {
  const l = await load()
  const entries = l.projects[id]?.entries ?? []
  const chat = await shapeOf(path ?? l.projects[id]?.path ?? null)
  return chatCost(id, entries, chat).dollars
}

/**
 * The averages: every chat the ledger has, read again from its file for what
 * it makes, and every recent chat with a video made from nothing (which kept
 * its own total before the ledger did). A chat from before the ledger with
 * neither is left out rather than counted as free.
 */
export async function costSummary(recent: { id: string; path: string }[]): Promise<CostSummary> {
  const l = await load()
  const seen = new Set<string>()
  const chats = []
  for (const [id, p] of Object.entries(l.projects)) {
    seen.add(id)
    chats.push(chatCost(id, p.entries, await shapeOf(p.path)))
  }
  for (const r of recent) {
    if (seen.has(r.id)) continue
    const chat = await shapeOf(r.path)
    if (!chat) continue
    const c = chatCost(r.id, [], chat)
    if (c.dollars > 0) chats.push(c)
  }
  return summarise(chats, l.loose)
}

/** Starts taking tickets from every paid call (main/usage) and answers the window's questions about cost. */
export function registerCosts(recent: () => Promise<{ id: string; path: string }[]>): void {
  setUsageSink((purpose) => {
    const to = open
    return (model, usage) => {
      const entry = entryFor(purpose, model ?? '', usage, new Date())
      void change((l) => record(l, to, entry))
    }
  })
  ipcMain.handle('costs:open', (_e, ref: ProjectRef | null) => setOpenChat(ref && typeof ref.id === 'string' ? ref : null))
  ipcMain.handle('costs:chat', (_e, req: { id: string; path: string | null }) => costOfChat(String(req.id), req.path ?? null))
  ipcMain.handle('costs:summary', async () => costSummary(await recent()))
}
