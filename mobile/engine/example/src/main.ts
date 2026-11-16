import { Engine, Host } from './plugins'
import { runSelfTest } from './selftest'

/**
 * The test app's one screen: the self-test, which runs by itself when the app
 * is launched with the self-test flag (CI does), and the pickers and Photos,
 * which need a person and are tried by hand.
 */

const log = document.getElementById('log') as HTMLPreElement
const buttons = Array.from(document.querySelectorAll('button'))
let lastExport: string | null = null

function say(line: string): void {
  log.textContent += `${line}\n`
  log.scrollTop = log.scrollHeight
  console.log(`[selftest] ${line}`)
}

async function busy(work: () => Promise<void>): Promise<void> {
  buttons.forEach((b) => (b.disabled = true))
  try {
    await work()
  } catch (e) {
    say(`stopped: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    buttons.forEach((b) => (b.disabled = false))
  }
}

async function selfTest(): Promise<void> {
  log.textContent = ''
  try {
    const report = await runSelfTest(say)
    lastExport = `${report.info?.documents}/selftest-out/desktop-cut.mp4`
  } catch (e) {
    // A report that says why, so whoever waits for one is not left waiting.
    const why = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)
    say(`the self-test could not finish: ${why}`)
    const info = await Engine.info()
    await Host.writeText({
      path: `${info.documents}/selftest.json`,
      text: JSON.stringify({ ok: false, passed: 0, failed: 1, skipped: 0, crashed: why, checks: [] }, null, 1)
    })
  }
}

document.getElementById('run')?.addEventListener('click', () => void busy(selfTest))

document.getElementById('pick-video')?.addEventListener('click', () =>
  void busy(async () => {
    const { files } = await Engine.pick({ multiple: true, kinds: ['video', 'image'] })
    say(`picked ${files.length}: ${JSON.stringify(files, null, 1)}`)
    for (const f of files) {
      const r = await Engine.run({ id: `probe-${f.name}`, tool: 'ffprobe', args: ['-v', 'error', '-show_format', '-of', 'json', f.path] })
      say(`${f.name}: exit ${r.code} ${r.stdout.replace(/\s+/g, ' ').slice(0, 300)}`)
    }
    if (files[0]) lastExport = files[0].path
  })
)

document.getElementById('pick-audio')?.addEventListener('click', () =>
  void busy(async () => {
    const { files } = await Engine.pick({ multiple: false, kinds: ['audio'] })
    say(`picked ${files.length}: ${JSON.stringify(files, null, 1)}`)
  })
)

document.getElementById('save')?.addEventListener('click', () =>
  void busy(async () => {
    if (!lastExport) {
      say('nothing to save yet: run the self-test or pick a video first')
      return
    }
    say(`saveToPhotos ${lastExport}: ${JSON.stringify(await Engine.saveToPhotos({ path: lastExport }))}`)
  })
)

void (async () => {
  const info = await Engine.info()
  say(`ffmpeg ${info.ffmpegVersion}, whisper ${info.whisperVersion} on ${info.platform}`)
  say(`encoders: ${info.encoders.filter((e) => /videotoolbox|mediacodec/.test(e)).join(', ') || 'no hardware encoder'}`)
  if ((await Host.launch()).selftest) await busy(selfTest)
})()
