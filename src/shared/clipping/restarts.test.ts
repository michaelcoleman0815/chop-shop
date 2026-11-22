import { describe, expect, it } from 'vitest'
import { currentCut, currentVersion, resolveCut } from '../edit'
import { clipDoc } from './doc'
import { CLIP_PROFILES } from './profile'
import { heardClosely, restartsIn } from './restarts'

/**
 * The lines are the owner's own Sunday service, as the close hearing wrote them (docs/research/sermon-clips.md,
 * "Restarts"): what a church's editor cuts, and what he says that way on purpose.
 */

interface Said {
  text: string
  startSec: number
  endSec: number
}

/** Words a third of a second each, a twentieth apart; "|" before a word is a pause of `pauseSec`. */
function line(text: string, pauseSec = 1, at = 0): Said[] {
  let t = at
  return text.split(' ').map((raw) => {
    if (raw.startsWith('|')) t += pauseSec
    const w = { text: raw.replace(/^\|/, ''), startSec: t, endSec: t + 0.3 }
    t += 0.35
    return w
  })
}

/** The line with its struck words in brackets. */
function marked(text: string, pauseSec?: number): string {
  const words = line(text, pauseSec)
  const struck = new Set(restartsIn(words))
  return words.map((w, i) => (struck.has(i) ? `[${w.text}]` : w.text)).join(' ')
}

describe('restarts in a sermon', () => {
  it('cut a broken-off word back to where he begins again', () => {
    expect(marked('God saves people. Religion never- religion never points you to God.')).toBe(
      'God saves people. [Religion] [never-] religion never points you to God.'
    )
    expect(marked('Well, we- we just- we can’t find it, but it’s what we believe.')).toBe(
      'Well, [we-] [we] [just-] we can’t find it, but it’s what we believe.'
    )
    expect(marked('I don’t want- I don’t want what you believe.')).toBe('[I] [don’t] [want-] I don’t want what you believe.')
    expect(marked('And so he was in- in that- in that place of prayer in Gethsemane.')).toBe(
      'And so he was [in-] [in] [that-] in that place of prayer in Gethsemane.'
    )
  })

  it('cut a correction through its "or"', () => {
    expect(marked('till his blood became- or his sweat became as drops of blood.')).toBe(
      'till [his] [blood] [became-] [or] his sweat became as drops of blood.'
    )
  })

  it('cut a broken-off word alone where he goes on with something else', () => {
    expect(marked('if it was God’s will to- that she was to be healed,')).toBe('if it was God’s will [to-] that she was to be healed,')
    expect(marked('You know, there’s- there was a couple that went to church here')).toBe(
      'You know, [there’s-] there was a couple that went to church here'
    )
  })

  it('cut a few words said twice straight away, written with commas', () => {
    expect(marked('You ever, you ever studied that scripture where it talks about')).toBe(
      '[You] [ever,] you ever studied that scripture where it talks about'
    )
    expect(marked('So as he is, as he is present, so are we in this world.')).toBe(
      'So [as] [he] [is,] as he is present, so are we in this world.'
    )
    expect(marked('For which I am an ambassador in bond. I am, I am in bond.')).toBe(
      'For which I am an ambassador in bond. [I] [am,] I am in bond.'
    )
    expect(marked('That it’s, it’s gonna be one of those days.')).toBe('That [it’s,] it’s gonna be one of those days.')
    expect(marked('Well, we just, we can’t find it.')).toBe('Well, [we] [just,] we can’t find it.')
  })

  it('leave what he says that way on purpose', () => {
    for (const said of [
      'It says you gotta do this, this, this, this, this, and this.',
      'Well, he did. He did. And I quoted that scripture.',
      'it’s gonna be one of those days, it’s gonna be one of those days, and everything hell’s gonna break.',
      'And he was praying, and he was praying to the Father,',
      'No, no, no. I’m up, hell. You listen to me.',
      'Whatever. Whatever it is. Whatever you wanna name.',
      'never, never give up on what he said.',
      'I’m more than a conqueror. I’m fixing to read the scripture to you. I’m more than a conqueror.',
      'I said one time that that God told us to go heal the sick.',
      // The clip's last word, trailing off: nothing is said after it.
      'and try to fit it, but God-'
    ])
      expect(marked(said)).toBe(said)
  })

  it('leave a word said again after a pause, as a new thought', () => {
    expect(marked('and the, |the people came', 1)).toBe('and the, the people came')
    expect(marked('I am, |I am in bond', 2)).toBe('I am, I am in bond')
    // A phrase begun again after a breath is still a restart.
    expect(marked('Religion never, |religion never points you to God.', 0.8)).toBe(
      '[Religion] [never,] religion never points you to God.'
    )
  })
})

describe('a clip heard again closely', () => {
  // First heard as the fast hearing heard it: the restart smoothed away, a pause where it was said again.
  const first = line('Religion kills people. God saves people. Religion never |points you to God.', 1.2, 100)
  const gap = first.findIndex((w) => w.text === 'points')

  it('stands in for the words first heard when it heard nearly all of them', () => {
    const at = first[gap - 1].endSec
    const close = [
      { text: 'Amen.', startSec: 98, endSec: 98.4 },
      ...first.slice(0, gap - 1),
      { ...first[gap - 1], text: 'never-' },
      { text: 'religion', startSec: at + 0.3, endSec: at + 0.6 },
      { text: 'never', startSec: at + 0.65, endSec: at + 0.95 },
      ...first.slice(gap),
      { text: 'Yes.', startSec: first[first.length - 1].endSec + 0.2, endSec: first[first.length - 1].endSec + 0.6 }
    ]
    const heard = heardClosely(first, close)
    // Only the clip's own words: the "Amen" before it and the "Yes" after are its neighbours'.
    expect(heard?.map((w) => w.text).join(' ')).toBe(
      'Religion kills people. God saves people. Religion never- religion never points you to God.'
    )
  })

  it('keeps the pauses the first hearing had, where it runs a word on into one', () => {
    // "God." runs on through the pause after it, and so does a restart word the first hearing never had.
    const at = gap - 1
    const close = first.map((w, i) =>
      i === 4 ? { ...w, endSec: first[5].startSec - 0.01 } : i === at ? { ...w, text: 'never-', endSec: w.endSec + 3 } : w
    )
    const heard = heardClosely(first, close)!
    expect(heard[4].endSec).toBeCloseTo(first[4].endSec)
    // "never-" is not the "never" first heard: it runs as long as its letters take, and no longer.
    expect(heard[at].endSec - heard[at].startSec).toBeLessThanOrEqual(0.9)
    // The clip opens on its own first word, not the end of the sentence before.
    const before = [{ text: 'know,', startSec: first[0].startSec - 0.24, endSec: first[0].startSec - 0.02 }, ...first]
    expect(heardClosely(first, before)![0].text).toBe('Religion')
    // Nor where its first word was heard again broken off, as "there's-" for "There".
    const broken = [before[0], { ...first[0], text: 'Religion’s-' }, ...first.slice(1)]
    expect(heardClosely(first, broken)!.map((w) => w.text).slice(0, 2)).toEqual(['Religion’s-', 'kills'])
  })

  it('is set aside where it heard something else, or a great deal more', () => {
    expect(heardClosely(first, line('When you get to the end of your rope, tie a knot in it and hang on.', 1, 100))).toBeNull()
    const more = line(Array(30).fill('God saves people.').join(' '), 1, 100).filter((w) => w.startSec <= 104)
    expect(heardClosely(first, more)).toBeNull()
    expect(heardClosely([], first)).toBeNull()
  })
})

describe('a sermon clip with restarts', () => {
  const source = { path: '/service.mp4', durationSec: 1400, width: 1920, height: 1080, fps: 30, audio: null }
  const words = line(
    'Religion kills people. God saves people. Religion never- religion never points you to God. Well, we- we just- we can’t find it, but it’s what we believe. Try to fit, but God-',
    1,
    600
  )

  it('strikes them in the finished short, and keeps them in the moment as said', () => {
    const doc = clipDoc({ id: 'r', title: 'Religion', source, words, profile: CLIP_PROFILES.church, variant: 1 })
    const said = doc.versions[0].cut
    expect(said.removed).toEqual([])
    const cut = currentCut(doc)
    const struck = doc.words.filter((w) => cut.removed.includes(w.id)).map((w) => w.text)
    expect(struck).toEqual(['Religion', 'never-', 'we-', 'we', 'just-'])
    // Played, the line is the one he meant.
    const played = resolveCut(cut, doc.words, doc.sources).words.map((w) => w.text)
    expect(played.join(' ')).toContain('God saves people. religion never points you to God. Well, we can’t find it')
    // The last word, trailing off, reads as the word.
    expect(doc.words[doc.words.length - 1].text).toBe('God')
    expect(currentVersion(doc).summary).toContain('2 false starts cut')
  })

  it('leaves them where the kind of clip does not cut them', () => {
    const doc = clipDoc({ id: 'p', title: 'Religion', source, words, profile: CLIP_PROFILES.podcast })
    expect(currentCut(doc).removed).toEqual([])
  })
})

