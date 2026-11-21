import { describe, expect, it } from 'vitest'
import { wordsFromTranscript } from '../edit'
import { BUILT_IN_PRESETS, planStyle } from '../presets'
import { docFor } from './eval'
import { FIXTURES } from './fixtures'
import lab from './lab-transcripts.json'
import { DEFAULT_PROFILE, profileById, PROFILES, styleForProfile, suggestProfile } from './profiles'

const preset = (command: string): (typeof BUILT_IN_PRESETS)[number] => {
  const p = BUILT_IN_PRESETS.find((x) => x.command === command)
  if (!p) throw new Error(command)
  return p
}

describe('cutting profiles', () => {
  it('suggests tech from what a review says, and nothing from too little', () => {
    const words = (lab.transcripts['verbatim prompt, no rolling context'] as { text: string }[]).map((w) => ({
      text: w.text
    }))
    const s = suggestProfile(words)
    expect(s?.profile.id).toBe('tech')
    expect(s?.confidence).toBeGreaterThan(0.5)
    expect(suggestProfile(words.slice(0, 10))).toBeNull()
    const plain = wordsFromTranscript(
      'I think the most important thing is to be kind to the people around you every single day of the week, even when it is hard and you are tired and nobody is watching what you do.'
        .split(' ')
        .map((text, i) => ({ text, startSec: i, endSec: i + 0.5 })),
      's1'
    )
    expect(suggestProfile(plain)).toBeNull()
  })

  it('sets the pauses /tighten and /snappy keep, and drops takes where they do not belong', () => {
    const tech = profileById('tech')!
    expect(styleForProfile('tighten', preset('tighten').style, tech).tighten).toEqual({
      maxGapSec: 0.25,
      padSec: 0.05,
      fillers: true
    })
    const podcast = profileById('podcast')!
    expect(styleForProfile('tighten', preset('tighten').style, podcast).tighten?.maxGapSec).toBe(0.6)
    const asmr = profileById('asmr')!
    const quiet = styleForProfile('snappy', preset('snappy').style, asmr)
    expect(quiet.tighten).toBeUndefined()
    expect(quiet.pad).toBeUndefined()
    expect(styleForProfile('takes', preset('takes').style, profileById('gaming')!).takes).toBeUndefined()
    // Presets that are not about pauses keep their own numbers.
    expect(styleForProfile('shorts', preset('shorts').style, podcast)).toEqual(preset('shorts').style)
    expect(PROFILES.map((p) => p.id)).toEqual([
      'talking-head',
      'tech',
      'podcast',
      'gaming',
      'livestream',
      'church',
      'vlog',
      'asmr'
    ])
    expect(DEFAULT_PROFILE.id).toBe('talking-head')
  })

  it('only offers retakes for ASMR, never cuts them', () => {
    const f = FIXTURES.find((x) => x.name === 'whole line said twice')!
    const { doc } = docFor(f)
    const asmr = profileById('asmr')!
    const plan = planStyle(doc, styleForProfile('takes', preset('takes').style, asmr), undefined, {
      thresholds: asmr.takes ?? undefined
    })
    expect(plan.ops).toEqual([])
    expect(plan.takes?.offers.length).toBe(1)
    expect(plan.takes?.offerText).toMatch(/^I left one possible retake in at 0:0\d/)
  })
})
