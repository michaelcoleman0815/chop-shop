import { useState, type DragEvent } from 'react'
import { thisComputer } from '../../../../shared/platform'
import { blockedSentence, costLine, keyGuide, keyMessage } from '../../../../shared/setup'
import { device } from '../api'
import { AiOptions, canRunLocal, ClaudeSteps, LocalSteps, type AiPick } from '../components/AiChoice'
import { Mark } from '../components/ui'
import type { Cutalong } from '../useCutalong'
import { BackToWork, Header } from './Header'
import { SignIn } from './settings/Account'

/**
 * Start, until an AI is ready to edit with: Claude, with the steps to an
 * Anthropic key and the field to paste it into, or a model on this computer
 * (components/AiChoice). The step's button is the one primary on the screen. When a key stops working, what
 * went wrong is said under the field and the step that fixes it is marked.
 * Nothing else runs from here: footage dropped on it waits for the key.
 */
export function KeySetup({ app }: { app: Cutalong }): JSX.Element {
  const guide = keyGuide('anthropic')
  const [refused, setRefused] = useState<string | null>(null)
  const [pick, setPick] = useState<AiPick>('claude')
  const [signingIn, setSigningIn] = useState(false)
  const key = app.claudeKey
  const work = app.work()

  // Footage or a link dropped here waits for the key, and the sentence says so.
  const drop = (e: DragEvent): void => {
    e.preventDefault()
    setRefused(blockedSentence(e.dataTransfer.files.length > 0 ? 'footage' : 'link', key, 'here'))
  }

  const works = (): void => {
    app.setToast({ text: keyMessage('ok') })
    // Sent here from a chat: back to it, now that it can go on.
    if (work) app.resume()
  }

  return (
    <>
      <BackToWork.Provider value={work ? { name: work.name, go: app.resume } : null}>
        <Header>
          <span className="spacer" />
        </Header>
      </BackToWork.Provider>
      <main className="cl-start cl-setup" onDragOver={(e) => e.preventDefault()} onDrop={drop}>
        <div className="cl-setup-inner">
          <span className="cl-start-mark" aria-hidden="true">
            <Mark size={44} />
          </span>
          {canRunLocal ? (
            <h1 className="cl-title">
              First, choose an AI
            </h1>
          ) : (
            <h1 className="cl-title">
              First, an Anthropic key
            </h1>
          )}
          <p className="cl-setup-why">
            {canRunLocal
              ? `Claude plans the best edits, with an Anthropic key. A model on ${thisComputer} is free and offline.`
              : guide.why}
          </p>
          {/* A new install of someone who already uses Cutalong: signing in brings the key with it (main/account). */}
          {signingIn ? (
            <SignIn onStatus={() => void app.refreshFromAccount()} />
          ) : (
            <p className="cl-setup-why">
              Already use Cutalong on another device?{' '}
              <button type="button" className="cl-link inline" onClick={() => setSigningIn(true)}>
                Sign in
              </button>{' '}
              and your key comes with you.
            </p>
          )}
          {canRunLocal && <AiOptions pick={pick} onPick={setPick} />}
          {pick === 'claude' ? (
            <ClaudeSteps
              app={app}
              id="cl-key"
              note={refused}
              // On a phone the keyboard would cover the steps, which come first there.
              autoFocus={device.kind !== 'phone'}
              onCheck={() => setRefused(null)}
              onWorks={works}
            />
          ) : (
            <LocalSteps app={app} onWorks={() => work && app.resume()} />
          )}
          {pick === 'claude' && (
          <footer className="cl-setup-cost">
            <p>
              {costLine()}{' '}
              {guide.spend && (
                <a className="cl-link inline" href={guide.spend.url} target="_blank" rel="noreferrer">
                  {guide.spend.label}
                  <span className="sr-only">, opens in your browser</span>
                </a>
              )}
            </p>
          </footer>
          )}
        </div>
      </main>
    </>
  )
}
