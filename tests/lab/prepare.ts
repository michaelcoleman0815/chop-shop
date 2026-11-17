/**
 * The app's own import, on local files: cut:session sorts which file is which
 * (by measurement, as without a key), then cut:prepare reads the talking clips
 * with any better sound lined up under them, exactly as the chat does when
 * footage is dropped. Writes the roles and the prepared doc (v1: the
 * recording split into beats, with its words and audio map) as JSON.
 *
 *   node scripts/lab.mjs prepare <out.json> <file> [<file> ...]
 */
import { writeFileSync } from 'fs'
import { registerCutalongIpc } from '../../src/main/cutalong'
import { fail, handler, progressLogger } from './handlers'

async function main(): Promise<void> {
  const [out, ...files] = process.argv.slice(2)
  if (!out || files.length === 0) throw new Error('usage: prepare <out.json> <file> [<file> ...]')
  const t0 = Date.now()
  const log = progressLogger()
  registerCutalongIpc({
    send: (_s, _channel, payload) => log((payload as { stage?: string }).stage ?? ''),
    mediaUrlFor: (p) => `file://${p}`
  })
  const event = { sender: {} }
  let session: unknown = null
  let talking = files
  let sound: string[] = []
  let broll: string[] = []
  if (files.length > 1) {
    const r = (await handler('cut:session')(event, { request: '', paths: files })) as {
      ok: boolean
      roles?: { talking: string[]; sound: string[]; broll: string[]; reply: string }
      message?: string
    }
    if (!r.ok || !r.roles) throw new Error(`cut:session failed: ${r.message}`)
    session = r
    ;({ talking, sound, broll } = r.roles)
    process.stderr.write(`roles: ${r.roles.reply}\n`)
  }
  const prepared = (await handler('cut:prepare')(event, { paths: talking, soundPaths: sound, brand: null })) as {
    ok: boolean
    message?: string
  }
  const sec = (Date.now() - t0) / 1000
  writeFileSync(out, JSON.stringify({ files, talking, sound, broll, session, prepared, sec }))
  process.stderr.write(`prepared in ${sec.toFixed(0)} s: ${prepared.ok ? 'ok' : prepared.message}\n`)
}

main().catch(fail)
