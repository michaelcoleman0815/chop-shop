import { describe, expect, it } from 'vitest'
import { failureOf, renderFailure } from './failure'

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

  it('takes a render failure as the main process said it, with what ffmpeg said behind Details', () => {
    const details = [{ label: 'What ffmpeg said', value: 'encoder : Lavc61.3.100 aac\nffmpeg was stopped by SIGKILL.' }]
    const stopped = 'The renderer was stopped before it finished, perhaps because the Mac ran short of memory, so nothing was saved.'
    expect(renderFailure({ message: stopped, details })).toEqual({ text: stopped, details })
    // From an app that sends only the lines, as before.
    expect(renderFailure({ message: 'Error while filtering\nConversion failed!' })).toEqual({
      text: 'The renderer stopped partway, so nothing was saved.',
      details: [{ label: 'What ffmpeg said', value: 'Error while filtering\nConversion failed!' }]
    })
    expect(renderFailure({ message: 'There is nothing left in the cut to render.' })).toEqual({
      text: 'There is nothing left in the cut to render.'
    })
  })
})
