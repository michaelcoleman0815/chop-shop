import { useEffect, useState, type CSSProperties } from 'react'
import { brandName } from '../../../../shared/brands'
import { onWindows } from '../../../../shared/platform'
import { api, device } from '../api'
import { CrewFace } from '../components/Crew'
import { Button } from '../components/ui'
import { CREW, CREW_ORDER, crewBlock, crewLearned, willLearn, type CrewId } from '../crew'
import type { Cutalong } from '../useCutalong'
import { Header } from './Header'

/**
 * The crew as a call sheet, one row each: what they do, what they have learned about how
 * you like it (from the brand: the style learned from your videos, the habits
 * learned from your edits, your B-roll sources), and anything they need to do
 * more, with the steps. Everything on it is what is really there. Before a
 * member has learned anything, their row says what they will learn; when no
 * one has yet, the page says so once, under its lede.
 */

interface Need {
  text: string
  steps: string[]
}

const MODEL_NAMES: Record<string, string> = {
  'base.en': 'Fast',
  'small.en': 'Balanced',
  'medium.en': 'Medium',
  'large-v3-turbo': 'Most accurate'
}

/** What the crew needs, from the device as it is: the transcription model, and the Claude key. */
function useNeeds(): Partial<Record<CrewId, Need>> {
  const [needs, setNeeds] = useState<Partial<Record<CrewId, Need>>>({})
  useEffect(() => {
    let live = true
    void (async () => {
      const [settings, key] = await Promise.all([api.getSettings(), api.hasApiKey()])
      const model = settings.whisperModel
      const hasModel = await api.hasModel(model)
      const next: Partial<Record<CrewId, Need>> = {}
      if (!hasModel)
        next.echo = {
          text: `The ${MODEL_NAMES[model] ?? model} transcription model, to write words down on ${device.here}. It downloads once.`,
          steps: ['Open Settings.', 'Under Transcription, choose Download now.']
        }
      if (!key) {
        const kept =
          device.kind === 'phone'
            ? `in ${device.keychain}`
            : onWindows
              ? 'locked to your Windows account'
              : 'in this computer’s keychain'
        next.quill = {
          text: `Your Anthropic key, so Claude writes your titles, descriptions and chapters. Without it, I write them on ${device.here}.`,
          steps: ['Open Settings.', `Paste your key under Claude and save it. It stays ${kept}.`]
        }
      }
      if (live) setNeeds(next)
    })().catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  return needs
}

export function CrewPage({ app }: { app: Cutalong }): JSX.Element {
  const learned = crewLearned(app.brand)
  const nothingYet = CREW_ORDER.every((id) => learned[id].length === 0)
  const needs = useNeeds()
  const several = app.brands.brands.length > 1
  // On a phone, learning from videos and edits is on the Mac for now (device.ts), and the page says so.
  const learnAway = device.away['feature:learn']
  return (
    <>
      <Header>
        <span className="spacer" />
      </Header>
      <main className="cl-page">
        <div className="cl-page-inner wide">
          <h1 className="cl-page-title">
            Your <span className="cl-accent">crew</span>
          </h1>
          <p className="cl-lede">
            They do the work while I talk with you, and each learns how you like it
            {several ? `, here from ${brandName(app.brand)}` : ''}.
            {nothingYet && (
              <span className="cl-lede-line">
                {' '}
                {learnAway
                  ? `Nothing learned yet. ${learnAway}`
                  : 'Nothing learned yet: they learn from the videos on your Brand page and from how you edit.'}
              </span>
            )}
          </p>
          {/* A call sheet: who is on the crew, what each does, what each knows of you and what each needs. */}
          <ul className="cl-callsheet">
            {CREW_ORDER.map((id) => {
              const m = CREW[id]
              const need = needs[id]
              return (
                <li key={id} style={{ '--block': crewBlock(id) } as CSSProperties} aria-labelledby={`crew-${id}`}>
                  <span className="cl-crew-tile">
                    <CrewFace id={id} size={56} />
                  </span>
                  <div className="cl-crew-who">
                    <h2 id={`crew-${id}`}>{m.name}</h2>
                    <span className="cl-crew-job">{m.job}</span>
                    <p className="cl-crew-does">{m.does}</p>
                  </div>
                  <div className="cl-crew-knows">
                    {learned[id].length > 0 ? (
                      <>
                        <h3>Learned</h3>
                        <ul className="cl-crew-learned">
                          {learned[id].map((l) => (
                            <li key={l}>{l}</li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <p className="cl-crew-none">{willLearn(id)}</p>
                    )}
                    {need && (
                      <div className="cl-crew-need">
                        <h3>Needs</h3>
                        <p>{need.text}</p>
                        <ol>
                          {need.steps.map((step) => (
                            <li key={step}>{step}</li>
                          ))}
                        </ol>
                        <Button small onClick={() => app.setScreen('settings')}>
                          Open Settings
                        </Button>
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      </main>
    </>
  )
}
