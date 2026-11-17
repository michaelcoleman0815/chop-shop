import { useEffect, useRef } from 'react'
import { Composer } from '../components/Composer'
import { AssistantMessage, UserMessage } from '../components/Message'
import { BrandSwitch } from '../components/BrandSwitch'
import { ClipSet } from '../components/ClipSet'
import { Button, Icon, IconButton } from '../components/ui'
import { prefersReducedMotion } from '../motion'
import type { Cutalong } from '../useCutalong'
import { Header } from './Header'

/** The conversation: what was given, what was understood, what happens next. */
export function Thread({ app }: { app: Cutalong }): JSX.Element {
  const end = useRef<HTMLDivElement>(null)
  // New turns glide into view; with reduced motion they are simply there.
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'end' })
  }, [app.messages])

  return (
    <>
      <Header>
        <IconButton label="Back to start" onClick={app.goStart}>
          <Icon.back />
        </IconButton>
        <span className="cl-heading">{app.doc?.title ?? app.work()?.name ?? 'New edit'}</span>
        <span className="spacer" />
        <BrandSwitch app={app} />
        {app.doc && (
          <Button variant="text" onClick={() => app.setScreen('editor')}>
            Editor
          </Button>
        )}
      </Header>
      <main className="cl-thread">
        <div className="cl-thread-scroll">
          <div className="cl-thread-column">
            {app.messages.map((m) =>
              m.role === 'user' ? (
                <UserMessage key={m.id} msg={m} />
              ) : (
                <AssistantMessage key={m.id} msg={m} onAction={app.onAction}>
                  {m.clipRun ? <ClipSet app={app} run={m.clipRun} /> : null}
                </AssistantMessage>
              )
            )}
            <div ref={end} />
          </div>
        </div>
        <div className="cl-thread-foot">
          <Composer
            placeholder="Reply, or type /"
            presets={app.presets}
            busy={app.busy}
            onSubmit={(t, f) => void app.submit(t, f)}
          />
        </div>
      </main>
    </>
  )
}
