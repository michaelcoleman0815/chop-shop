import { createServer, type Server } from 'http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FloatReader, joinBytes, platform, setPlatform, toolOf, type Platform } from './platform'
import { downloadFile, nodePlatform, runProgram } from './platform-node'
import { loudnessEnvelope } from './audio-envelope'
import { findFfmpeg } from './test-media'

const FFMPEG = findFfmpeg()

describe('the platform', () => {
  it('reads floats that arrive split anywhere, as one stream', () => {
    const values = [0.5, -0.25, 1e-3, 3.75, -2]
    const bytes = new Uint8Array(new Float32Array(values).buffer)
    for (const cuts of [[1], [3, 6], [4, 8, 9], [19]]) {
      const reader = new FloatReader()
      const out: number[] = []
      let at = 0
      for (const end of [...cuts, bytes.length]) {
        out.push(...reader.push(bytes.subarray(at, end)))
        at = end
      }
      expect(out).toEqual(values.map((v) => Math.fround(v)))
    }
  })

  it('joins chunks and tells a tool from its path or name', () => {
    expect([...joinBytes([new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3])])]).toEqual([1, 2, 3])
    expect(toolOf('/Applications/Cutalong.app/Contents/Resources/bin/whisper-cli')).toBe('whisper')
    expect(toolOf('C:\\ffmpeg\\bin\\ffprobe.exe')).toBe('ffprobe')
    expect(toolOf('ffmpeg')).toBe('ffmpeg')
    expect(toolOf('/opt/ffmpeg-6.0/ffmpeg-linux-x64')).toBe('ffmpeg')
  })

  it('says plainly when no platform is installed, and uses the one that is', () => {
    const before = platform()
    try {
      setPlatform(null as unknown as Platform)
      expect(() => platform()).toThrow(/No platform is installed/)
    } finally {
      setPlatform(before)
    }
    expect(platform().kind).toBe('computer')
  })
})

describe('the computer platform', () => {
  const root = mkdtempSync(join(tmpdir(), 'cutalong-platform-'))
  const host = nodePlatform({
    tools: { ffmpeg: () => 'ffmpeg', ffprobe: () => 'ffprobe', whisper: () => 'whisper-cli' },
    userData: () => join(root, 'data'),
    temp: () => join(root, 'tmp'),
    exports: () => join(root, 'out'),
    projects: () => join(root, 'projects'),
    fonts: () => null
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('streams what a program writes and keeps the end of its errors', async () => {
    const lines: string[] = []
    const r = await runProgram(
      process.execPath,
      ['-e', 'console.log("one"); console.log("two"); console.error("x".repeat(70000) + "end"); process.exit(3)'],
      {
        onStdout: (t) => lines.push(t)
      }
    )
    expect(r.code).toBe(3)
    expect(lines.join('')).toBe('one\ntwo\n')
    expect(r.stdout).toBe('one\ntwo\n')
    expect(r.stderr.length).toBe(64 * 1024)
    expect(r.stderr.trim().endsWith('end')).toBe(true)
  })

  it('hands stdout over as bytes when asked, and keeps none of it as text', async () => {
    const got: Uint8Array[] = []
    const r = await runProgram(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0, 1, 2, 255]))'], {
      onBytes: (b) => got.push(b)
    })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    expect([...joinBytes(got)]).toEqual([0, 1, 2, 255])
  })

  it('fails to start a program that is not there, and stops one when asked', async () => {
    await expect(runProgram(join(root, 'nothing-here'), [])).rejects.toThrow()
    const stop = new AbortController()
    const run = runProgram(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { signal: stop.signal })
    setTimeout(() => stop.abort(), 100)
    await expect(run).rejects.toThrow(/abort/i)
  })

  it('keeps files, folders and names the way the work expects', async () => {
    const f = host.files
    const dir = join(root, 'a', 'b')
    await f.mkdir(dir)
    await f.writeText(join(dir, 'x.txt'), 'héllo')
    expect(await f.readText(join(dir, 'x.txt'))).toBe('héllo')
    expect((await f.stat(join(dir, 'x.txt')))?.size).toBe(6)
    expect(await f.stat(join(dir, 'nope'))).toBeNull()
    await f.rename(join(dir, 'x.txt'), join(dir, 'y.txt'))
    await f.copy(join(dir, 'y.txt'), join(dir, 'z.txt'))
    expect((await f.list(dir)).map((e) => e.name).sort()).toEqual(['y.txt', 'z.txt'])
    expect(await f.list(join(root, 'missing'))).toEqual([])
    // Claiming a name is one step: the second asker is told it is taken.
    expect(await f.claim(join(dir, 'export.mp4'))).toBe(true)
    expect(await f.claim(join(dir, 'export.mp4'))).toBe(false)
    const temp = await f.tempDir('cutalong-x-')
    expect(temp.startsWith(join(root, 'tmp', 'cutalong-x-'))).toBe(true)
    await f.remove(join(root, 'a'))
    await f.remove(join(root, 'a'))
    expect(await f.stat(dir)).toBeNull()
  })

  it('keeps settings in userData and keys in memory unless the host gives a keychain', async () => {
    await host.files.mkdir(host.paths.userData())
    await host.settings.write({ whisperModel: 'base.en' })
    expect(await host.settings.read()).toEqual({ whisperModel: 'base.en' })
    expect(JSON.parse(readFileSync(join(root, 'data', 'settings.json'), 'utf8'))).toEqual({ whisperModel: 'base.en' })
    expect(await host.secrets.get('anthropic')).toBeNull()
    await host.secrets.set('anthropic', 'sk-ant-test')
    expect(await host.secrets.get('anthropic')).toBe('sk-ant-test')
    await host.secrets.remove('anthropic')
    expect(await host.secrets.get('anthropic')).toBeNull()
  })

  describe('fetching a large file', () => {
    const body = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 251))
    let server: Server
    let base = ''
    let ranges: (string | undefined)[] = []
    beforeAll(async () => {
      server = createServer((req, res) => {
        ranges.push(req.headers.range)
        const m = /bytes=(\d+)-/.exec(req.headers.range ?? '')
        const from = m ? Number(m[1]) : 0
        res.writeHead(m ? 206 : 200, { 'content-length': String(body.length - from) })
        res.end(body.subarray(from))
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      const a = server.address()
      base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
    })
    afterAll(() => server.close())

    it('reports progress and only puts the file in place when all of it is there', async () => {
      const dest = join(root, 'model.bin')
      const seen: number[] = []
      ranges = []
      await downloadFile(fetch, `${base}/model.bin`, dest, (p) => seen.push(p))
      expect(readFileSync(dest).equals(body)).toBe(true)
      expect(Math.max(...seen)).toBe(99)
      expect(ranges).toEqual([undefined])
    })

    it('picks a partial file up where it stopped', async () => {
      const dest = join(root, 'resumed.bin')
      writeFileSync(`${dest}.part`, body.subarray(0, 50_000))
      ranges = []
      await downloadFile(fetch, `${base}/model.bin`, dest, () => undefined)
      expect(ranges).toEqual(['bytes=50000-'])
      expect(readFileSync(dest).equals(body)).toBe(true)
    })
  })
})

describe.skipIf(!FFMPEG)('ffmpeg through the platform', () => {
  it('hears loudness from raw samples streamed from ffmpeg, the same however they are split', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cutalong-platform-env-'))
    try {
      const wav = join(root, 'tone.wav')
      await runProgram(FFMPEG as string, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=f=440:d=1,volume=0.5',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=44100:cl=mono:d=1',
        '-filter_complex',
        '[0][1]concat=n=2:v=0:a=1',
        wav
      ])
      const whole = await loudnessEnvelope(FFMPEG as string, wav)
      // The same run, with stdout handed over a few bytes at a time.
      const before = platform()
      const trickle: Platform = {
        ...before,
        run: (bin, args, opts) =>
          before.run(bin, args, {
            ...opts,
            onBytes: opts?.onBytes
              ? (b) => {
                  for (let i = 0; i < b.length; i += 7) opts.onBytes?.(b.subarray(i, i + 7))
                }
              : undefined
          })
      }
      setPlatform(trickle)
      let split: Awaited<ReturnType<typeof loudnessEnvelope>>
      try {
        split = await loudnessEnvelope(FFMPEG as string, wav)
      } finally {
        setPlatform(before)
      }
      expect(whole.db.length).toBe(200)
      expect(Array.from(split.db)).toEqual(Array.from(whole.db))
      // The tone (ffmpeg's sine is an eighth of full scale, halved: -27 dB), then silence.
      expect(whole.db[50]).toBeCloseTo(-27, 0)
      expect(whole.db[150]).toBeLessThan(-100)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
