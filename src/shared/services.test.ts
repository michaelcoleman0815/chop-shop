import { describe, expect, it } from 'vitest'
import { chosenTranscriber, isServiceId, serviceName, servicesOn, SERVICES, wrongServiceKey } from './services'

describe('the other AI services switch', () => {
  it('is on unless it was turned off, including in settings saved before it existed', () => {
    expect(servicesOn({})).toBe(true)
    expect(servicesOn(JSON.parse('{"whisperModel":"small.en","outputDir":"/Users/you/Movies"}'))).toBe(true)
    expect(servicesOn({ otherServices: true })).toBe(true)
    expect(servicesOn({ otherServices: false })).toBe(false)
    expect(servicesOn(null)).toBe(true)
  })

  it('says under the Deepgram key that the audio is not used to improve its models', () => {
    expect(SERVICES.find((s) => s.id === 'deepgram')?.note).toBe(
      'I ask Deepgram not to use your audio to improve its models, so it keeps neither the audio nor the words once it has answered.'
    )
  })

  it('says under the Gemini key what Google may do with excerpts on a free key, as its terms put it', () => {
    expect(SERVICES.find((s) => s.id === 'gemini')?.note).toBe(
      'On a free Gemini key, one without billing on its Google Cloud project, Google may use the excerpts I send and its answers to improve its products, and people at Google may review them, unless you are in the EEA, Switzerland or the UK.'
    )
    expect(SERVICES.find((s) => s.id === 'assemblyai')?.note).toBeUndefined()
  })

  it('names each service plainly', () => {
    expect(SERVICES.map((s) => s.name)).toEqual(['Deepgram', 'AssemblyAI', 'Google Gemini'])
    expect(serviceName('gemini')).toBe('Google Gemini')
    expect(isServiceId('deepgram')).toBe(true)
    expect(isServiceId('anthropic')).toBe(false)
    expect(isServiceId(undefined)).toBe(false)
  })
})

describe('who hears the words', () => {
  const keys =
    (...ids: string[]) =>
    (id: string): boolean =>
      ids.includes(id)

  it('is this computer while there is no transcription key, even with the switch on', () => {
    expect(chosenTranscriber({}, keys())).toBeNull()
    expect(chosenTranscriber({}, keys('gemini'))).toBeNull()
  })

  it('is the first transcription service with a key when nothing was picked', () => {
    expect(chosenTranscriber({}, keys('deepgram'))).toBe('deepgram')
    expect(chosenTranscriber({}, keys('assemblyai'))).toBe('assemblyai')
    expect(chosenTranscriber({}, keys('assemblyai', 'deepgram'))).toBe('deepgram')
  })

  it('is the picked service while it has a key, and the other one when its key is gone', () => {
    expect(chosenTranscriber({ transcriber: 'assemblyai' }, keys('assemblyai', 'deepgram'))).toBe('assemblyai')
    expect(chosenTranscriber({ transcriber: 'assemblyai' }, keys('deepgram'))).toBe('deepgram')
  })

  it('is this computer when the person picked it, or when the switch is off', () => {
    expect(chosenTranscriber({ transcriber: 'local' }, keys('deepgram'))).toBeNull()
    expect(chosenTranscriber({ otherServices: false }, keys('deepgram', 'assemblyai'))).toBeNull()
    expect(chosenTranscriber({ otherServices: false, transcriber: 'deepgram' }, keys('deepgram'))).toBeNull()
  })

  it('ignores a pick it does not know', () => {
    expect(chosenTranscriber({ transcriber: 'whisper-cloud' }, keys('assemblyai'))).toBe('assemblyai')
  })
})

describe('keys pasted into the wrong field', () => {
  it('turns away keys that are plainly another company’s', () => {
    expect(wrongServiceKey('deepgram', 'sk-ant-api03-abc')).toBe(
      'That looks like an Anthropic key. It goes in the Claude section.'
    )
    expect(wrongServiceKey('gemini', 'sk-proj-abc')).toBe(
      'That looks like an OpenAI key. Google Gemini needs its own key.'
    )
    expect(wrongServiceKey('assemblyai', 'AIzaSyabc')).toBe(
      'That looks like a Google key. AssemblyAI needs its own key.'
    )
  })

  it('lets through keys worth trying', () => {
    expect(wrongServiceKey('gemini', 'AIzaSyabc')).toBeNull()
    expect(wrongServiceKey('deepgram', '0123456789abcdef0123456789abcdef01234567')).toBeNull()
    expect(wrongServiceKey('assemblyai', '0123456789abcdef0123456789abcdef')).toBeNull()
  })
})
