import { useEffect, useState, type CSSProperties, type DragEvent } from 'react'
import { costLine, doneSteps, fixingStep, keyGuide, keyMessage } from '../../../../shared/setup'
import { api, device, isMock } from '../api'
import { ClaudeKeyField } from '../components/ClaudeKeyField'
import { KeySteps } from '../components/KeySteps'
import { BrandAvatar } from '../components/Shapes'
import { Button, Mark } from '../components/ui'
import { markOnboarded } from '../firstRun'
import { isVideoFile } from '../format'
import { avatarOf, block } from '../shapes'
import type { Cutalong } from '../useCutalong'
import { AvatarPicker } from './Brand'
import { Header } from './Header'

/**
 * The first run, one step a screen: what Cutalong does, an account, the
 * Anthropic key, your channel, and a few of your videos to learn from. Then
 * Start, where the rail's setup card carries on until the first export.
 *
 * The account step is drawn but not yet wired to a service, so it shows only
 * in the browser mock; the app skips it until accounts exist.
 */
type Step = 'welcome' | 'account' | 'key' | 'channel' | 'teach'

const STEPS: Step[] = [
  'welcome',
  ...(isMock ? (['account'] as const) : []),
  'key',
  'channel',
  // Learning a look from videos is on the Mac for now (device.ts).
  ...(device.away['feature:learn'] ? [] : (['teach'] as const))
]

export function Onboarding({ app, onDone }: { app: Cutalong; onDone: () => void }): JSX.Element {
  const [at, setAt] = useState(0)
  const step = STEPS[at]
  // A key that already works needs no step of its own, either way through.
  const skip = (s: Step): boolean => s === 'key' && app.gateOpen
  const go = (dir: 1 | -1): void => {
    let i = at + dir
    while (STEPS[i] && skip(STEPS[i])) i += dir
    if (i >= STEPS.length) {
      markOnboarded()
      onDone()
      return
    }
    setAt(Math.max(0, i))
  }
  const next = (): void => go(1)
  const back = (): void => go(-1)

  return (
    <>
      <Header>
        <span className="spacer" />
      </Header>
      <main className="cl-onboard">
        <div className="cl-onboard-top">
          <Mark size={30} />
          <div className="cl-dots" role="img" aria-label={`Step ${at + 1} of ${STEPS.length}`}>
            {STEPS.map((s, i) => (
              <i key={s} className={i === at ? 'now' : i < at ? 'past' : ''} />
            ))}
          </div>
        </div>
        {step === 'welcome' && <Welcome onNext={next} />}
        {step === 'account' && <Account onNext={next} />}
        {step === 'key' && <Key app={app} onNext={next} />}
        {step === 'channel' && <Channel app={app} />}
        {step === 'teach' && <Teach app={app} />}
        {step !== 'welcome' && step !== 'account' && step !== 'key' && (
          <div className="cl-onboard-foot">
            <Button variant="text" onClick={back}>
              Back
            </Button>
            <div className="cl-onboard-actions">
              {step === 'teach' && (
                <Button variant="text" onClick={next}>
                  Skip for now
                </Button>
              )}
              <Button variant="primary" onClick={next}>
                {at === STEPS.length - 1 ? 'Finish setup' : 'Next'}
              </Button>
            </div>
          </div>
        )}
        {(step === 'account' || step === 'key') && (
          <div className="cl-onboard-foot">
            <Button variant="text" onClick={back}>
              Back
            </Button>
            <span className="cl-onboard-note">
              Step {at + 1} of {STEPS.length}
            </span>
          </div>
        )}
      </main>
    </>
  )
}

/** What Cutalong does, shown rather than said: a script with its cuts, and the strip under it. */
function Welcome({ onNext }: { onNext: () => void }): JSX.Element {
  return (
    <div className="cl-onboard-body">
      <div className="cl-onboard-say">
        <h1 className="cl-welcome">
          Talk to your <span className="cl-accent">footage</span>.
        </h1>
        <p className="cl-onboard-lede">
          Drop a shoot and say what you want. I cut it on the words, keep every change as a version you can go back
          to, and hand you the upload kit at the end.
        </p>
        <div className="cl-onboard-actions">
          <Button variant="primary" onClick={onNext}>
            Get started
          </Button>
        </div>
        <p className="cl-onboard-note">
          Runs on your Mac. Claude reads what you ask, through your own Anthropic key, so you pay Anthropic for what
          you use.
        </p>
      </div>
      <div className="cl-stage cl-demo" aria-hidden="true">
        <div className="cl-demo-script">
          <header>
            <span>Script · v2</span>
            <span>0:41 of pauses out</span>
          </header>
          <p>
            <span>1</span>
            <s>Okay so, um, is this on? Right.</s>
          </p>
          <p>
            <span>2</span>Grace looks like a kitchen table.
          </p>
          <p>
            <span>3</span>
            <span>
              Somebody pulls out a chair <s>for, for</s> for you
            </span>
          </p>
          <p>
            <span>4</span>before you have earned it.
          </p>
          <p>
            <span>5</span>
            <s>Let me try that again.</s>
          </p>
          <p>
            <span>6</span>That is the whole sermon, really.
          </p>
        </div>
        <div className="cl-demo-strip">
          <span className="on" style={{ flex: 2 }}>
            Hook
          </span>
          <span style={{ flex: 3 }}>Kitchen table</span>
          <span style={{ flex: 2 }}>Chair</span>
          <span style={{ flex: 3 }}>Earned</span>
          <span style={{ flex: 2 }}>Close</span>
          <span className="cl-playhead" />
        </div>
      </div>
    </div>
  )
}

/** An account, so brands, presets and chats follow you to your phone. Not wired yet (see above). */
function Account({ onNext }: { onNext: () => void }): JSX.Element {
  return (
    <div className="cl-onboard-body">
      <div className="cl-onboard-say">
        <h1 className="cl-welcome step">
          Make your <span className="cl-accent" style={{ '--hl': 'var(--block-lavender)' } as CSSProperties}>account</span>.
        </h1>
        <p className="cl-onboard-lede">So your brands, presets and chats are there on your phone too. The cutting still happens on your Mac.</p>
        <div className="cl-signin">
          <Button variant="primary" onClick={onNext}>
            Continue with Apple
          </Button>
          <Button onClick={onNext}>Continue with Google</Button>
          <div className="cl-or">or with email</div>
          <Button onClick={onNext}>Continue with email</Button>
        </div>
        <p className="cl-onboard-note">
          Already have one?{' '}
          <button type="button" className="cl-link inline" onClick={onNext}>
            Sign in
          </button>
          . No password: I email you a code.
        </p>
      </div>
      <div className="cl-onboard-block" style={{ '--tone': 'var(--block-lavender)' } as CSSProperties}>
        <span className="cl-kicker">Your account keeps</span>
        <ul className="cl-onboard-list">
          <li>
            <span className="cl-dot" style={{ '--bloom': 'var(--bloom-green)' } as CSSProperties} />
            <div>
              <b>Your brands</b>
              <span>Look, captions, the words never to cut.</span>
            </div>
          </li>
          <li>
            <span className="cl-dot" style={{ '--bloom': 'var(--bloom-yellow)' } as CSSProperties} />
            <div>
              <b>Your presets</b>
              <span>Commands you made, ready on every device.</span>
            </div>
          </li>
          <li>
            <span className="cl-dot" style={{ '--bloom': 'var(--bloom-blue)' } as CSSProperties} />
            <div>
              <b>Your chats and versions</b>
              <span>Pick up an edit on the other device.</span>
            </div>
          </li>
        </ul>
        <div className="cl-onboard-paper">
          <b style={{ fontSize: 14 }}>Stays on your Mac</b>
          <p className="cl-onboard-note" style={{ color: 'var(--ink-soft)', fontSize: 14, lineHeight: '21px' }}>
            Your footage, the renders and your Anthropic key. Nothing is uploaded to edit.
          </p>
        </div>
      </div>
    </div>
  )
}

/** The Anthropic key: the same steps and field as Settings, moving on once the key works. */
function Key({ app, onNext }: { app: Cutalong; onNext: () => void }): JSX.Element {
  const guide = keyGuide('anthropic')
  const key = app.claudeKey
  const failing = key.state !== 'none' && key.state !== 'ok' && key.state !== 'checking'
  return (
    <div className="cl-onboard-body">
      <div className="cl-onboard-say">
        <h1 className="cl-welcome step">
          First, an Anthropic <span className="cl-accent" style={{ '--hl': 'var(--block-pink)' } as CSSProperties}>key</span>.
        </h1>
        <p className="cl-onboard-lede">{guide.why}</p>
        <p className="cl-onboard-note">
          {costLine()}{' '}
          {guide.spend && (
            <a className="cl-link inline" href={guide.spend.url} target="_blank" rel="noreferrer">
              {guide.spend.label}
              <span className="sr-only">, opens in your browser</span>
            </a>
          )}
        </p>
      </div>
      <div className="cl-setup-inner">
        <KeySteps
          service="anthropic"
          current={failing ? fixingStep(key.state) : null}
          done={failing ? doneSteps(key.state) : 0}
          paste={{
            id: 'cl-key',
            field: (
              <ClaudeKeyField
                app={app}
                id="cl-key"
                note={null}
                autoFocus={device.kind !== 'phone'}
                onWorks={() => {
                  app.setToast({ text: keyMessage('ok') })
                  onNext()
                }}
              />
            )
          }}
        />
      </div>
    </div>
  )
}

/** Your channel: its name, and its shape and colour in Cutalong, shown as the brand it makes. */
function Channel({ app }: { app: Cutalong }): JSX.Element {
  const brand = app.brand
  const [name, setName] = useState(brand.name)
  useEffect(() => setName(brand.name), [brand.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const avatar = avatarOf(brand)
  const save = (patch: Partial<typeof brand>): void => app.saveBrand({ ...brand, ...patch })
  return (
    <div className="cl-onboard-body">
      <div className="cl-onboard-say">
        <h1 className="cl-welcome step">
          Who is this <span className="cl-accent" style={{ '--hl': 'var(--block-green)' } as CSSProperties}>for</span>?
        </h1>
        <p className="cl-onboard-lede">
          One brand per channel. What you set here rides along on every edit: your look, your captions, the words you
          never want cut.
        </p>
        <label className="cl-field" style={{ width: '100%', maxWidth: 520 }}>
          <span>Channel name</span>
          <input
            value={name}
            placeholder="Your channel"
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name !== brand.name && save({ name: name.trim() })}
          />
        </label>
        <AvatarPicker value={avatar} onPick={(a) => save({ name: name.trim(), avatar: a })} />
      </div>
      <div className="cl-onboard-block" style={{ '--tone': block(avatar.colour) } as CSSProperties}>
        <span className="cl-kicker">How it shows up</span>
        <div className="cl-brand-preview">
          <BrandAvatar avatar={avatar} size={84} />
          <div>
            <strong>{name.trim() || 'Your channel'}</strong>
            <span className="cl-onboard-note" style={{ color: 'var(--ink-soft)' }}>
              New edits get it automatically
            </span>
          </div>
        </div>
        <p className="cl-onboard-note" style={{ color: 'var(--ink-soft)' }}>
          You can add another brand for a second channel later.
        </p>
      </div>
    </div>
  )
}

/** A few videos you have posted, so I learn your pace, captions and look. Optional. */
function Teach({ app }: { app: Cutalong }): JSX.Element {
  const videos = app.brand.videos.slice(-3)
  const progress = app.brandProgress
  const add = async (): Promise<void> => {
    const meta = await api.openVideo()
    if (meta) void app.learnFrom([meta.path])
  }
  const drop = (e: DragEvent): void => {
    e.preventDefault()
    const paths = [...e.dataTransfer.files].filter((f) => isVideoFile(f.name)).map((f) => api.pathForFile(f))
    if (paths.length) void app.learnFrom(paths)
  }
  return (
    <div className="cl-onboard-body one" style={{ maxWidth: 1180 }}>
      <div className="cl-onboard-say">
        <h1 className="cl-welcome step">
          Show me what you’ve <span className="cl-accent" style={{ '--hl': 'var(--block-gold)' } as CSSProperties}>made</span>.
        </h1>
        <p className="cl-onboard-lede">
          Up to three videos you’ve posted. I learn your pace, your captions and your look from them. You can skip
          this and do it later on the Brand page.
        </p>
      </div>
      <div className="cl-stage cl-teach" onDragOver={(e) => e.preventDefault()} onDrop={drop}>
        {videos.map((v) => (
          <div key={v.path} className="cl-teach-video">
            <span aria-hidden="true" />
            <b>{v.title}</b>
            <span className="cl-onboard-note">Read</span>
          </div>
        ))}
        {progress && (
          <div className="cl-teach-video">
            <span aria-hidden="true" />
            <b>{progress.stage}</b>
            <span className="cl-onboard-note">{progress.percent}%</span>
          </div>
        )}
        {videos.length < 3 && (
          <button type="button" className="cl-teach-slot" onClick={() => void add()}>
            <span className="cl-icon-btn" aria-hidden="true">
              +
            </span>
            Drop a video you’ve posted, or choose one
          </button>
        )}
      </div>
      <p className="cl-onboard-note">What I learn shows on your Brand page, where you can change it.</p>
    </div>
  )
}
