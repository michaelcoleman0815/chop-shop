import { useEffect, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import { thisComputer, yourComputer } from '../../../../shared/platform'
import { PROFILES, type CuttingProfile } from '../../../../shared/raw/profiles'
import { costLine, keyGuide, keyMessage } from '../../../../shared/setup'
import { api, device, isMock } from '../api'
import { AiOptions, canRunLocal, ClaudeSteps, LocalSteps, type AiPick } from '../components/AiChoice'
import { BrandAvatar } from '../components/Shapes'
import { Button, Mark } from '../components/ui'
import { markOnboarded } from '../firstRun'
import { isVideoFile } from '../format'
import { avatarOf, block } from '../shapes'
import type { Cutalong } from '../useCutalong'
import { AvatarPicker } from './Brand'
import { Header } from './Header'

/**
 * The first run, one step a screen: what Cutalong does, an account, what you
 * make, where your footage goes, the Anthropic key, your channel, and a few of
 * your videos to learn from. Then Start, where the rail's setup card carries
 * on until the first export.
 *
 * The account step is drawn but not yet wired to a service, so it shows only
 * in the browser mock; the app skips it until accounts exist.
 */
type Step = 'welcome' | 'account' | 'make' | 'trust' | 'key' | 'channel' | 'teach'

const STEPS: Step[] = [
  'welcome',
  ...(isMock ? (['account'] as const) : []),
  'make',
  'trust',
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
        {step === 'make' && <Make app={app} />}
        {step === 'trust' && <Trust />}
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
          Runs on {device.kind === 'phone' ? device.here : yourComputer}. Claude reads what you ask, through your own
          Anthropic key, so you pay Anthropic for what you use.
        </p>
      </div>
      <div className="cl-stage cl-demo" aria-hidden="true">
        <div className="cl-demo-script">
          <header>
            <span>Script · v2</span>
            <span>0:41 of pauses out</span>
          </header>
          <p>
            <span>1</span>So I’ve had the Google Book for a day now.
          </p>
          <p>
            <span>2</span>And I’m just going to be honest.
          </p>
          <p>
            <span>3</span>It feels like a really expensive Chromebook.
          </p>
          <p>
            <span>4</span>
            <s>Like the Chromebook you had in school.</s>
          </p>
          <p>
            <span>5</span>Like the Chromebook you had in school was maybe three or four hundred bucks,
          </p>
          <p>
            <span>6</span>but this starts at nine hundred bucks.
          </p>
        </div>
        <div className="cl-demo-strip">
          <span style={{ flex: 2 }}>Day one</span>
          <span style={{ flex: 2 }}>Honest</span>
          <span className="on" style={{ flex: 3 }}>
            Chromebook
          </span>
          <span style={{ flex: 3 }}>$900</span>
          <span style={{ flex: 2 }}>The catch</span>
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
          Make your account.
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

/** A plain line icon, drawn as Settings draws its marks: an 18-unit box, one stroke, no fill. */
function LineIcon({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** Each kind of video's mark on its tile, by cutting profile. */
const KIND_ICONS: Record<string, ReactNode> = {
  'talking-head': (
    <>
      <circle cx="9" cy="6.5" r="3" />
      <path d="M3.5 15.5c.8-2.9 3-4.5 5.5-4.5s4.7 1.6 5.5 4.5" />
    </>
  ),
  tech: (
    <>
      <rect x="3" y="4" width="12" height="8" rx="1.5" />
      <path d="M1.5 14.5h15" />
    </>
  ),
  podcast: (
    <>
      <rect x="6.5" y="2" width="5" height="8.5" rx="2.5" />
      <path d="M4 8.5a5 5 0 0 0 10 0M9 13.5V16M6.5 16h5" />
    </>
  ),
  gaming: (
    <>
      <rect x="2" y="5.5" width="14" height="8" rx="4" />
      <path d="M5.75 8v3M4.25 9.5h3" />
      <circle cx="11.75" cy="8.75" r=".45" />
      <circle cx="13.25" cy="10.25" r=".45" />
    </>
  ),
  livestream: (
    <>
      <circle cx="9" cy="9" r="1.5" />
      <path d="M6 6a4.25 4.25 0 0 0 0 6M12 6a4.25 4.25 0 0 1 0 6M3.6 3.6a7.6 7.6 0 0 0 0 10.8M14.4 3.6a7.6 7.6 0 0 1 0 10.8" />
    </>
  ),
  church: <path d="M9 1.5v4M7.25 3.25h3.5M3.5 16V9.5L9 6l5.5 3.5V16M2 16h14M7.5 16v-2.75a1.5 1.5 0 0 1 3 0V16" />,
  vlog: (
    <>
      <rect x="2" y="5" width="10" height="8" rx="2" />
      <path d="m12 8.25 4-2.25v6l-4-2.25" />
    </>
  ),
  asmr: (
    <>
      <path d="M3 12V9a6 6 0 0 1 12 0v3" />
      <rect x="2" y="11" width="3.5" height="5" rx="1.5" />
      <rect x="12.5" y="11" width="3.5" height="5" rx="1.5" />
    </>
  )
}

/** What a profile's cut does, from its own line: "I cut it as a podcast: pauses up to 0.6 s…" → "Pauses up to 0.6 s…". */
function cutLine(p: CuttingProfile): string {
  const what = p.says.replace(/^[^:]*:\s*/, '')
  return what.charAt(0).toUpperCase() + what.slice(1)
}

/**
 * What you make most: one cutting profile, saved to the brand's niche as the
 * Brand page saves it, the moment it is picked. Picking it again takes it
 * back, so the words decide; Next goes on either way.
 */
function Make({ app }: { app: Cutalong }): JSX.Element {
  const brand = app.brand
  const pick = (id: string): void => app.saveBrand({ ...brand, niche: brand.niche === id ? '' : id })
  return (
    <div className="cl-onboard-body one cl-make">
      <div className="cl-onboard-say">
        <h1 className="cl-welcome step">What do you make?</h1>
        <p className="cl-onboard-lede">
          Pick what you make most. I cut it the way that kind of video is cut. You can change it on your Brand page.
        </p>
      </div>
      <div className="cl-make-tiles" role="group" aria-label="What you make">
        {PROFILES.map((p) => (
          <button
            key={p.id}
            type="button"
            className="cl-make-tile"
            aria-pressed={brand.niche === p.id}
            onClick={() => pick(p.id)}
          >
            {KIND_ICONS[p.id] && <LineIcon>{KIND_ICONS[p.id]}</LineIcon>}
            <span className="cl-make-name">{p.name}</span>
            <span className="cl-make-what">{cutLine(p)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Where your footage goes, as the code has it: transcribed and cut on the
 * device; Claude reads the words through your own key (and, on a computer, a
 * vlog's stills unless that is off); other services only once their key is
 * added; the key kept in the device's keychain.
 */
function Trust(): JSX.Element {
  const phone = device.kind === 'phone'
  const rows: { id: string; icon: ReactNode; label: string; line: string }[] = [
    {
      id: 'here',
      icon: phone ? (
        <>
          <rect x="5" y="2" width="8" height="14" rx="2" />
          <path d="M8 13.5h2" />
        </>
      ) : (
        <>
          <rect x="3" y="3.5" width="12" height="8.5" rx="1.5" />
          <path d="M1.5 14.5h15" />
        </>
      ),
      label: `Cut on ${device.here}`,
      line: `I transcribe your footage and cut it here, and it stays ${phone ? 'in the app' : 'where you keep it'}.`
    },
    {
      id: 'claude',
      icon: <path d="M3 5h12M3 9h12M3 13h7" />,
      label: 'Claude reads the words',
      line:
        'It reads what you ask, the transcript, and the files’ names and lengths, through your own Anthropic key, and never the video or the sound.' +
        (phone ? '' : ' For a vlog it also sees three small stills of each moment, unless you turn that off in Settings.')
    },
    {
      id: 'services',
      icon: <path d="M6.5 2.5V6M11.5 2.5V6M4.5 6h9v2.5a4.5 4.5 0 0 1-9 0V6ZM9 13v2.5" />,
      label: 'Other services only if you add them',
      line: 'Deepgram or AssemblyAI hear the sound, and Gemini sees short clips, only once you add a key for them in Settings.'
    },
    {
      id: 'key',
      icon: (
        <>
          <circle cx="6" cy="9" r="3.2" />
          <path d="M9.2 9H16M13.5 9v2.5M15.8 9v2" />
        </>
      ),
      label: `Your key stays in ${device.keychain}`,
      line: 'I only ever send it to Anthropic.'
    }
  ]
  return (
    <div className="cl-onboard-body">
      <div className="cl-onboard-say">
        <h1 className="cl-welcome step">Your footage stays yours.</h1>
        <p className="cl-onboard-lede">Here is what I do with it, and what leaves {device.here}.</p>
      </div>
      <div className="cl-onboard-block cl-trust">
        <ul className="cl-onboard-list" role="list">
          {rows.map((r) => (
            <li key={r.id}>
              <span className="cl-trust-mark" aria-hidden="true">
                <LineIcon>{r.icon}</LineIcon>
              </span>
              <div>
                <b>{r.label}</b>
                <span>{r.line}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** Which AI edits with you: Claude's two steps to a key, or a model on this computer; moving on once one works. */
function Key({ app, onNext }: { app: Cutalong; onNext: () => void }): JSX.Element {
  const guide = keyGuide('anthropic')
  const [pick, setPick] = useState<AiPick>('claude')
  return (
    <div className="cl-onboard-body">
      <div className="cl-onboard-say">
        {canRunLocal ? (
          <h1 className="cl-welcome step">
            First, choose an AI.
          </h1>
        ) : (
          <h1 className="cl-welcome step">
            First, an Anthropic key.
          </h1>
        )}
        <p className="cl-onboard-lede">
          {canRunLocal
            ? `Claude plans the best edits, with an Anthropic key. A model on ${thisComputer} is free and offline.`
            : guide.why}
        </p>
        {pick === 'claude' && (
          <p className="cl-onboard-note">
            {costLine()}{' '}
            {guide.spend && (
              <a className="cl-link inline" href={guide.spend.url} target="_blank" rel="noreferrer">
                {guide.spend.label}
                <span className="sr-only">, opens in your browser</span>
              </a>
            )}
          </p>
        )}
      </div>
      <div className="cl-setup-inner">
        {canRunLocal && <AiOptions pick={pick} onPick={setPick} />}
        {pick === 'claude' ? (
          <ClaudeSteps
            app={app}
            id="cl-key"
            autoFocus={device.kind !== 'phone'}
            onWorks={() => {
              app.setToast({ text: keyMessage('ok') })
              onNext()
            }}
          />
        ) : (
          <LocalSteps app={app} onWorks={onNext} />
        )}
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
          Who is this for?
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
          <BrandAvatar avatar={avatar} size={84} name={name} />
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
          Show me what you’ve made.
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
