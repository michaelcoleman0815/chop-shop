/**
 * A doc's current version through the app's own export (cut:render, "final"),
 * into the output folder in the lab's settings.
 *
 *   node scripts/lab.mjs render <doc.json> <name>
 */
import { readFileSync } from 'fs'
import { registerCutalongIpc } from '../../src/main/cutalong'
import { fail, handler, progressLogger } from './handlers'

async function main(): Promise<void> {
  const [docPath, name] = process.argv.slice(2)
  if (!docPath || !name) throw new Error('usage: render <doc.json> <name>')
  const doc = JSON.parse(readFileSync(docPath, 'utf8')) as unknown
  const t0 = Date.now()
  const log = progressLogger()
  registerCutalongIpc({
    send: (_s, _channel, payload) => {
      const p = payload as { stage?: string; percent?: number | null }
      log(p.stage ?? '', p.percent)
    },
    mediaUrlFor: (p) => `file://${p}`
  })
  const r = (await handler('cut:render')({ sender: {} }, { doc, quality: 'final', name })) as Record<string, unknown>
  process.stdout.write(`${JSON.stringify({ ...r, upload: undefined }, null, 1)}\n`)
  process.stderr.write(`render ${r.ok ? 'ok' : 'failed'} in ${((Date.now() - t0) / 1000).toFixed(0)} s\n`)
  if (!r.ok) process.exit(1)
}

main().catch(fail)
