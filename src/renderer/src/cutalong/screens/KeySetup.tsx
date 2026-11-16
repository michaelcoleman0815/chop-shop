import { useState, type DragEvent } from 'react'
import { blockedSentence, costLine, fixingStep, keyGuide, keyMessage } from '../../../../shared/setup'
import { ClaudeKeyField } from '../components/ClaudeKeyField'
import { KeySteps } from '../components/KeySteps'
import type { Cutalong } from '../useCutalong'
import { BackToWork, Header } from './Header'

/**
 * Start, until an Anthropic key works: why Cutalong needs one, the steps to
 * get one with a button for each page, and the field to paste it into, whose
 * button is the one primary on the screen. When a key stops working, what
 * went wrong is said under the field and the step that fixes it is marked.
 * Nothing else runs from here: footage dropped on it waits for the key.
 */
export function KeySetup({ app }: { app: Cutalong }): JSX.Element {
  const guide = keyGuide('anthropic')
  const [refused, setRefused] = useState<string | null>(null)
  const key = app.claudeKey
  const failing = key.state !== 'none' && key.state !== 'ok' && key.state !== 'checking'
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
          <h1 className="cl-title">First, an Anthropic key</h1>
          <p className="cl-setup-why">{guide.why}</p>
          <KeySteps
            service="anthropic"
            current={failing ? fixingStep(key.state) : null}
            paste={{
              id: 'cl-key',
              field: (
                <ClaudeKeyField
                  app={app}
                  id="cl-key"
                  note={refused}
                  autoFocus
                  onCheck={() => setRefused(null)}
                  onWorks={works}
                />
              )
            }}
          />
          <p className="cl-setup-cost">
            {costLine()}{' '}
            {guide.spend && (
              <a className="cl-link" href={guide.spend.url} target="_blank" rel="noreferrer">
                {guide.spend.label}
                <span className="sr-only">, opens in your browser</span>
              </a>
            )}
          </p>
        </div>
      </main>
    </>
  )
}
