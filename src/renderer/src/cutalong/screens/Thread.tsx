import { useEffect, useRef } from 'react'
import { Composer } from '../components/Composer'
import { AssistantMessage, UserMessage } from '../components/Message'
import { BrandSwitch } from '../components/BrandSwitch'
import { ClipSet } from '../components/ClipSet'
import { KeptScript, MakeBrief } from '../components/MakeBrief'
import { MakeQuestions } from '../components/MakeQuestions'
import { AssistantAvatar, Button, Icon, IconButton } from '../components/ui'
import { prefersReducedMotion } from '../motion'
import type { Cutalong } from '../useCutalong'
import { Header } from './Header'

/** The conversation: what was given, what was understood, what happens next. */
export function Thread({ app }: { app: Cutalong }): JSX.Element {
  const end = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  // New turns glide into view; with reduced motion they are simply there.
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'end' })
  }, [app.messages])
  // The reply box grows with a longer reply. If the end of the conversation was in view, it stays in view.
  useEffect(() => {
    const el = scroller.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let atEnd = true
    const onScroll = (): void => {
      atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    }
    const watch = new ResizeObserver(() => {
      if (atEnd) el.scrollTop = el.scrollHeight
    })
    el.addEventListener('scroll', onScroll, { passive: true })
    watch.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      watch.disconnect()
    }
  }, [])

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
        <div className="cl-thread-scroll" ref={scroller}>
          <div className="cl-thread-column">
            {app.messages.map((m) =>
              m.role === 'user' ? (
                <UserMessage key={m.id} msg={m} />
              ) : (
                <AssistantMessage key={m.id} msg={m} onAction={app.onAction}>
                  {m.clipRun ? <ClipSet app={app} run={m.clipRun} /> : null}
                  {m.make ? <MakeBrief app={app} id={m.make} /> : m.script ? <KeptScript script={m.script} /> : null}
                  {m.makeAsk ? <MakeQuestions app={app} id={m.makeAsk} /> : null}
                </AssistantMessage>
              )
            )}
            {/* Writing back: from the moment a message is sent until the reply, or a step of work, appears. */}
            {app.busy && app.messages[app.messages.length - 1]?.role === 'user' && <Typing />}
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

/** Cutalong writing a reply: its mark breathing, as it does while it thinks, and three dots where the words will be. */
function Typing(): JSX.Element {
  return (
    <div className="cl-msg-assistant cl-typing" role="status" aria-label="Cutalong is writing a reply">
      <AssistantAvatar working />
      <div className="cl-msg-body">
        <span className="cl-typing-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </div>
    </div>
  )
}
