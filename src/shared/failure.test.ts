import { describe, expect, it } from 'vitest'
import { failureOf } from './failure'

describe('a failure as the chat says it', () => {
  it('keeps a sentence the app wrote', () => {
    expect(failureOf("I can't find MVI_9293.MP4. It was at /Volumes/SD/MVI_9293.MP4")).toEqual({
      text: "I can't find MVI_9293.MP4. It was at /Volumes/SD/MVI_9293.MP4."
    })
    expect(failureOf('There is nothing in the cut to render.')).toEqual({ text: 'There is nothing in the cut to render.' })
  })

  it("puts ffmpeg's own lines behind Details, under a plain sentence", () => {
    const raw = [
      '[h264 @ 0x7f8] error while decoding MB 41 22',
      'Error while filtering: Cannot allocate memory',
      'Failed to inject frame into filter network: Cannot allocate memory',
      'Error while processing the decoded data for stream #0:0',
      'Conversion failed!'
    ].join('\n')
    const said = failureOf(raw)
    expect(said.text).toBe('The renderer stopped partway, so nothing was saved.')
    expect(said.details).toEqual([{ label: 'What ffmpeg said', value: raw }])
  })

  it('says something when there is nothing to say', () => {
    expect(failureOf('  ').text).toBe('Something stopped it partway.')
  })
})
