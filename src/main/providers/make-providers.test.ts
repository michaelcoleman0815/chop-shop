import { describe, expect, it } from 'vitest'
import { ServiceError } from './gate'
import { falClip, falImage, FAL_CLIP_MODEL, FAL_EDIT_MODEL, FAL_IMAGE_MODEL, FAL_QUEUE } from './fal'
import { fromTts, googleClip, googleImage, googleSpeech, GOOGLE_CLIP_MODEL, GOOGLE_IMAGE_MODEL, INTERACTIONS_URL, TTS_URL } from './google-make'
import { gateFor, json, scriptedFetch } from './testing'
import { elevenSpeech, ELEVENLABS_MODEL, wordsFromCharacters } from './voices'

/**
 * The services a made video uses, as their documentation shows them (URLs
 * in each module): what each request carries, what each answer becomes, and
 * what a refusal, a slow answer or a missing key does. Only text and the
 * pictures the run chose go out; a key is only ever sent to its own host.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32])
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64')
const sheet = { data: new Uint8Array([7, 7, 7, 7]), mime: 'image/png' }

const madeImage = json({ status: 'completed', steps: [{ type: 'thought', content: [{ type: 'image', data: b64(new Uint8Array([9])) }] }, { type: 'model_output', content: [{ type: 'image', data: b64(PNG), mime_type: 'image/png' }] }] })

describe('Google: pictures and clips through the Interactions API', () => {
  it('sends the prompt and the chosen sheet, with the key in its header, and reads the model output, not a thought', async () => {
    const f = scriptedFetch([() => madeImage])
    const gate = gateFor(f.fetch, { keys: { gemini: 'g-key' } })
    const pic = await googleImage(gate, 'A 1950s derrick at dusk.', [sheet], { aspect: 'wide', size: '2K' })
    expect(Buffer.from(pic.data)).toEqual(Buffer.from(PNG))
    const [req] = f.sent
    expect(req.method).toBe('POST')
    expect(req.url).toBe(INTERACTIONS_URL)
    expect(req.headers.get('x-goog-api-key')).toBe('g-key')
    const body = JSON.parse(req.text ?? '{}')
    expect(body).toEqual({
      model: GOOGLE_IMAGE_MODEL,
      input: [
        { type: 'image', data: b64(sheet.data), mime_type: 'image/png' },
        { type: 'text', text: 'A 1950s derrick at dusk.' }
      ],
      store: false,
      response_format: { type: 'image', mime_type: 'image/png', aspect_ratio: '16:9', image_size: '2K' }
    })
  })

  it('makes a clip from its first frame, silent, 720p, for the seconds asked', async () => {
    const f = scriptedFetch([() => json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', data: b64(MP4), mime_type: 'video/mp4' }] }] })])
    const clip = await googleClip(gateFor(f.fetch, { keys: { gemini: 'g' } }), 'Oil rains down.', { data: PNG, mime: 'image/png' }, { aspect: 'vertical', seconds: 5 })
    expect(clip.mime).toBe('video/mp4')
    const body = JSON.parse(f.sent[0].text ?? '{}')
    expect(body.model).toBe(GOOGLE_CLIP_MODEL)
    expect(body.input[0]).toEqual({ type: 'image', data: b64(PNG), mime_type: 'image/png' })
    expect(body.response_format).toEqual({ type: 'video', aspect_ratio: '9:16', resolution: '720p', duration: '5s' })
  })

  it('says plainly when Google declines, and when a key has no billing behind it', async () => {
    const declined = scriptedFetch([() => json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'I cannot make that.' }] }] })])
    await expect(googleImage(gateFor(declined.fetch, { keys: { gemini: 'g' } }), 'x', [], { aspect: 'wide', size: '1K' })).rejects.toMatchObject({ kind: 'declined' })
    const unpaid = scriptedFetch([() => json({ error: { message: 'Quota exceeded for metric: free_tier_requests, limit: 0' } }, 429)])
    await expect(googleImage(gateFor(unpaid.fetch, { keys: { gemini: 'g' } }), 'x', [], { aspect: 'wide', size: '1K' })).rejects.toMatchObject({
      kind: 'refused',
      message: expect.stringMatching(/billing/)
    })
  })

  it('reads Gemini speech as WAV, wrapping raw L16 at its stated rate', async () => {
    const f = scriptedFetch([() => json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: b64(new Uint8Array([1, 0, 2, 0])) } }] } }] })])
    const wav = await googleSpeech(gateFor(f.fetch, { keys: { gemini: 'g' } }), 'In 1950.', 'Charon', 'Read calmly.')
    expect(Buffer.from(wav.slice(0, 4)).toString('ascii')).toBe('RIFF')
    expect(Buffer.from(wav).readUInt32LE(24)).toBe(24000)
    expect(f.sent[0].url).toBe(TTS_URL)
    expect(JSON.parse(f.sent[0].text ?? '{}').contents[0].parts[0]).toEqual({ text: 'In 1950.', speech_metadata: { style: 'Read calmly.' } })
    expect(() => fromTts({ promptFeedback: { blockReason: 'SAFETY' } })).toThrow(/declined/)
  })
})

describe('fal.ai: the queue, then the file from its media host', () => {
  const queued = (endpoint: string) =>
    json({
      request_id: 'r1',
      status_url: `${FAL_QUEUE}/${endpoint}/requests/r1/status`,
      response_url: `${FAL_QUEUE}/${endpoint}/requests/r1`,
      cancel_url: `${FAL_QUEUE}/${endpoint}/requests/r1/cancel`
    })

  it('submits, waits, fetches the result and downloads the picture without the key', async () => {
    const f = scriptedFetch([
      () => queued(FAL_EDIT_MODEL),
      () => json({ status: 'IN_PROGRESS' }),
      () => json({ status: 'COMPLETED' }),
      () => json({ images: [{ url: 'https://v3.fal.media/files/abc.png', content_type: 'image/png' }] }),
      () => new Response(PNG, { status: 200 })
    ])
    const pic = await falImage(gateFor(f.fetch, { keys: { fal: 'fal-key' } }), 'A boom town at night.', [sheet], { aspect: 'wide', size: '2K', pollMs: 1 })
    expect(Buffer.from(pic.data)).toEqual(Buffer.from(PNG))
    expect(f.sent.map((s) => `${s.method} ${s.url}`)).toEqual([
      `POST ${FAL_QUEUE}/${FAL_EDIT_MODEL}`,
      `GET ${FAL_QUEUE}/${FAL_EDIT_MODEL}/requests/r1/status`,
      `GET ${FAL_QUEUE}/${FAL_EDIT_MODEL}/requests/r1/status`,
      `GET ${FAL_QUEUE}/${FAL_EDIT_MODEL}/requests/r1`,
      'GET https://v3.fal.media/files/abc.png'
    ])
    for (const s of f.sent.slice(0, 4)) expect(s.headers.get('authorization')).toBe('Key fal-key')
    // The key never goes to the media host.
    expect(f.sent[4].headers.get('authorization')).toBeNull()
    const body = JSON.parse(f.sent[0].text ?? '{}')
    expect(body).toMatchObject({ prompt: 'A boom town at night.', aspect_ratio: '16:9', resolution: '2K', image_urls: [`data:image/png;base64,${b64(sheet.data)}`] })
  })

  it('uses the plain text-to-image model with no references, and makes a silent clip from a start frame', async () => {
    const f = scriptedFetch([
      () => queued(FAL_IMAGE_MODEL),
      () => json({ status: 'COMPLETED' }),
      () => json({ images: [{ url: `data:image/png;base64,${b64(PNG)}` }] }),
      () => queued(FAL_CLIP_MODEL),
      () => json({ status: 'COMPLETED' }),
      () => json({ video: { url: 'https://fal.media/files/clip.mp4' } }),
      () => new Response(MP4, { status: 200 })
    ])
    const gate = gateFor(f.fetch, { keys: { fal: 'k' } })
    await falImage(gate, 'A derrick.', [], { aspect: 'vertical', size: '1K', pollMs: 1 })
    expect(f.sent[0].url).toBe(`${FAL_QUEUE}/${FAL_IMAGE_MODEL}`)
    expect(JSON.parse(f.sent[0].text ?? '{}').image_urls).toBeUndefined()
    const clip = await falClip(gate, 'Oil sprays up.', { data: PNG, mime: 'image/png' }, { seconds: 5, pollMs: 1 })
    expect(clip.mime).toBe('video/mp4')
    expect(JSON.parse(f.sent[3].text ?? '{}')).toMatchObject({ start_image_url: `data:image/png;base64,${b64(PNG)}`, duration: '5', generate_audio: false })
  })

  it('cancels a request that takes too long, and calls a content refusal a refusal', async () => {
    const slow = scriptedFetch([() => queued(FAL_IMAGE_MODEL), () => json({ status: 'IN_QUEUE' }), () => json({}, 200)])
    await expect(falImage(gateFor(slow.fetch, { keys: { fal: 'k' } }), 'x', [], { aspect: 'wide', size: '1K', pollMs: 1, maxMs: -1 })).rejects.toMatchObject({ kind: 'timeout' })
    expect(slow.sent[2]).toMatchObject({ method: 'PUT', url: `${FAL_QUEUE}/${FAL_IMAGE_MODEL}/requests/r1/cancel` })
    const refused = scriptedFetch([() => queued(FAL_IMAGE_MODEL), () => json({ status: 'COMPLETED', error: 'Content policy violation', error_type: 'content_policy' })])
    await expect(falImage(gateFor(refused.fetch, { keys: { fal: 'k' } }), 'x', [], { aspect: 'wide', size: '1K', pollMs: 1 })).rejects.toMatchObject({ kind: 'declined' })
  })

  it('downloads only from fal’s own media hosts', async () => {
    const f = scriptedFetch([() => queued(FAL_IMAGE_MODEL), () => json({ status: 'COMPLETED' }), () => json({ images: [{ url: 'https://example.com/steal.png' }] })])
    await expect(falImage(gateFor(f.fetch, { keys: { fal: 'k' } }), 'x', [], { aspect: 'wide', size: '1K', pollMs: 1 })).rejects.toBeInstanceOf(ServiceError)
    expect(f.sent.some((s) => s.url.includes('example.com'))).toBe(false)
  })
})

describe('voices', () => {
  it('ElevenLabs: the text with its neighbours for flow, and each word timed from the characters', async () => {
    const chars = 'In 1950, oil.'.split('')
    const f = scriptedFetch([
      () =>
        json({
          audio_base64: b64(new Uint8Array([1, 2, 3])),
          alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.1), character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.08) }
        })
    ])
    const said = await elevenSpeech(gateFor(f.fetch, { keys: { elevenlabs: 'e-key' } }), 'JBFqnCBsd6RMkjVDRZzb', 'In 1950, oil.', { previous: 'Before.', next: 'After.' })
    expect(said.words.map((w) => w.text)).toEqual(['In', '1950,', 'oil.'])
    expect(said.words[1].startSec).toBeCloseTo(0.3)
    expect(f.sent[0].url).toMatch(/^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/JBFqnCBsd6RMkjVDRZzb\/with-timestamps/)
    expect(f.sent[0].headers.get('xi-api-key')).toBe('e-key')
    expect(JSON.parse(f.sent[0].text ?? '{}')).toMatchObject({ text: 'In 1950, oil.', model_id: ELEVENLABS_MODEL, previous_text: 'Before.', next_text: 'After.' })
    expect(wordsFromCharacters({ characters: [], character_start_times_seconds: [], character_end_times_seconds: [] })).toEqual([])
  })
})

describe('nothing leaves without the key and the switch', () => {
  it('sends no request without a key, or with other AI services off', async () => {
    for (const opts of [{ keys: {} }, { on: false, keys: { gemini: 'g', fal: 'f', elevenlabs: 'e' } }]) {
      const f = scriptedFetch([])
      const gate = gateFor(f.fetch, opts)
      await expect(googleImage(gate, 'x', [], { aspect: 'wide', size: '1K' })).rejects.toBeInstanceOf(ServiceError)
      await expect(falImage(gate, 'x', [], { aspect: 'wide', size: '1K', pollMs: 1 })).rejects.toBeInstanceOf(ServiceError)
      await expect(elevenSpeech(gate, 'JBFqnCBsd6RMkjVDRZzb', 'x', {})).rejects.toBeInstanceOf(ServiceError)
      expect(f.spy).not.toHaveBeenCalled()
    }
  })
})
