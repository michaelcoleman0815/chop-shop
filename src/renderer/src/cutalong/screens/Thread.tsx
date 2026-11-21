import { useEffect, useRef, useState } from 'react'
import { Composer } from '../components/Composer'
import { AssistantMessage, StepLine, UserMessage } from '../components/Message'
import { BrandSwitch } from '../components/BrandSwitch'
import { ClipSet } from '../components/ClipSet'
import { KeptScript, MakeBrief } from '../components/MakeBrief'
import { MakeQuestions } from '../components/MakeQuestions'
import { PreFlight } from '../components/PreFlight'
import { Button, Icon, IconButton } from '../components/ui'
import { api, device } from '../api'
import { prefersReducedMotion } from '../motion'
import { notifyChoice, setNotify } from '../notify'
import { isThinking } from '../working'
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

  // Asked once, on a computer, under long work: whether to send a note when it is done (notify.ts).
  const [asked, setAsked] = useState(() => notifyChoice() !== null)
  const longWork = app.messages.some((m) => m.progress && !isThinking(m.progress.stage))
  const offerNotes = device.kind !== 'phone' && !asked && longWork
  const answerNotes = (on: boolean): void => {
    setNotify(on)
    setAsked(true)
    // The system asks too, the first time; a note sent once it is allowed says the work is done.
    if (on) void api.notify({ title: 'Cutalong', body: 'I’ll tell you here when it’s ready.', actions: [] })
  }

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
            {app.messages.map((m, i) =>
              m.role === 'user' ? (
                <UserMessage key={m.id} msg={m} />
              ) : m.step && !m.progress && app.messages.slice(i + 1).some((n) => n.role === 'assistant') ? (
                // Taking the footage in, once the reply after it is in: one line of work, its facts behind Details.
                <StepLine key={m.id} msg={m} />
              ) : (
                <AssistantMessage key={m.id} msg={m} onAction={app.onAction}>
                  {m.clipRun ? <ClipSet app={app} run={m.clipRun} /> : null}
                  {m.make ? <MakeBrief app={app} id={m.make} /> : m.script ? <KeptScript script={m.script} /> : null}
                  {m.makeAsk ? <MakeQuestions app={app} id={m.makeAsk} /> : null}
                  {m.preflight ? (
                    <PreFlight card={m.preflight} open={app.preflightOpen(m.id)} onStart={app.startCut} />
                  ) : null}
                </AssistantMessage>
              )
            )}
            {offerNotes && (
              <div className="cl-tellme" role="group" aria-label="Tell you when it’s ready?">
                <div className="cl-tellme-say">
                  <span className="cl-tellme-title">Tell you when it’s ready?</span>
                  <span className="cl-tellme-line">Switch to another app if you like. I keep cutting on {device.here}.</span>
                </div>
                <div className="cl-tellme-actions">
                  <Button variant="text" onClick={() => answerNotes(false)}>
                    Not now
                  </Button>
                  <Button variant="primary" onClick={() => answerNotes(true)}>
                    Tell me
                  </Button>
                </div>
              </div>
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
