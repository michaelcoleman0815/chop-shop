import { useCallback, useContext, useEffect, useState } from 'react'
import { averageLine, type CostSummary } from '../../../../../shared/costs'
import { thisComputer } from '../../../../../shared/platform'
import { PLAN_QUALITIES, PLAN_QUALITY_INFO, planQualityOf } from '../../../../../shared/plan-quality'
import { ASK_OVER, doneSteps, fixingStep, keyGuide, money, planCostLine, planQualityCost } from '../../../../../shared/setup'
import type { Settings } from '../../../../../shared/types'
import { api, device } from '../../api'
import { ClaudeKeyField } from '../../components/ClaudeKeyField'
import { KeySteps } from '../../components/KeySteps'
import { Button, Icon } from '../../components/ui'
import type { Cutalong } from '../../useCutalong'
import { SetGroup, SetRow, SetSegments, SetSelect, SetSwitch, SettingsFind } from './rows'

/** What an edit may come to before it waits for a yes, in dollars. */
const ASKS = [
  { id: '0', label: 'Always ask' },
  { id: String(ASK_OVER), label: `Ask over ${money(ASK_OVER)}` },
  { id: '0.5', label: 'Ask over 50 cents' },
  { id: 'never', label: 'Don’t ask' }
] as const

/**
 * The AI in Settings, in one place: which one edits with you, picked from a
 * menu (Claude, or a model on this computer), and under it what that one
 * needs. Claude needs the Anthropic key; a local model needs a server on this
 * computer that runs it (Ollama, LM Studio, or one at an address typed here).
 * A phone edits with Claude only, so it shows Claude's rows and no menu.
 * While something is typed in Settings' search, every row shows, so each can
 * be found whichever AI is picked.
 */

type Choice = 'claude' | 'local'
type Server = Awaited<ReturnType<typeof api.localPlanners>>

const phone = device.kind === 'phone'

/** Names that say a model sees pictures, for a server that does not say so itself. */
const SEES = /llava|vision|-vl\b|vl[:-]|qwen2\.5vl|qwen2-vl|moondream|minicpm-v|gemma-?3|bakllava|mistral-small3\.[12]|llama4/i

/** What the server is, in a word: Ollama by its own API; LM Studio at its usual port; otherwise a local server. */
function serverName(s: Server): string {
  if (s.kind === 'ollama') return 'Ollama'
  return s.host && /:1234\b/.test(s.host) ? 'LM Studio' : 'A local server'
}

const shortHost = (host: string | null): string => (host ?? '').replace(/^https?:\/\//, '')

export function AiSection({
  app,
  settings,
  onSettings
}: {
  app: Cutalong
  settings: Settings | null
  onSettings: (next: Settings) => void
}): JSX.Element {
  const finding = useContext(SettingsFind) !== ''
  const planner = settings ? (settings.localPlanner ?? null) : app.localAi
  // Local AI may be picked before it has a model to plan with: the menu says so, and Claude edits until one is.
  const [choice, setChoice] = useState<Choice>(planner ? 'local' : 'claude')
  useEffect(() => {
    if (planner) setChoice('local')
  }, [planner])

  const [server, setServer] = useState<Server | null>(null)
  const [looking, setLooking] = useState(false)
  const look = useCallback(async (): Promise<void> => {
    if (phone) return
    setLooking(true)
    try {
      setServer(await api.localPlanners())
    } finally {
      setLooking(false)
    }
  }, [])
  useEffect(() => {
    void look()
  }, [look])

  const models = server?.models.map((m) => m.name) ?? []
  const plan = async (model: string | null): Promise<void> => {
    await app.chooseLocalAi(model)
    onSettings(await api.getSettings())
  }
  const pick = (next: Choice): void => {
    setChoice(next)
    if (next === 'claude') void plan(null)
    else if (!planner && models.length > 0) void plan(models[0])
  }

  const key = app.claudeKey
  const working = key.state === 'ok' || (key.state === 'checking' && key.confirmed)
  const local = !phone && choice === 'local'
  const editsWith = local
    ? planner
      ? `${planner} plans edits, vlogs and clips on ${device.here}, free and offline. Claude plans them better.`
      : `Pick a model under Local AI. Until then Claude edits${working ? '' : ', once it has a key'}.`
    : working
      ? 'Claude reads what you ask and plans each edit, vlog and clip.'
      : 'Claude plans edits best. It needs an Anthropic key, below.'

  return (
    <>
      {!phone && (
        <SetGroup>
          <SetRow
            title="Edits with"
            desc={editsWith}
            find="ai model planner claude local ollama lm studio offline"
            control={
              <SetSelect
                value={choice}
                disabled={!settings}
                options={[
                  { id: 'claude', label: 'Claude' },
                  { id: 'local', label: 'Local AI' }
                ]}
                onChange={pick}
              />
            }
          />
        </SetGroup>
      )}
      {!phone && (local || finding) && (
        <LocalRows
          settings={settings}
          onSettings={onSettings}
          server={server}
          looking={looking}
          onLook={look}
          planner={planner}
          onPlanner={plan}
        />
      )}
      {(!local || finding) && <ClaudeRows app={app} settings={settings} onSettings={onSettings} titled={!phone} />}
      {/* Claude still sees frames and writes upload text with a key while a local model plans. */}
      {local && !finding && app.keySaved && (
        <ClaudeRows app={app} settings={settings} onSettings={onSettings} titled alongside />
      )}
    </>
  )
}

function ClaudeRows({
  app,
  settings,
  onSettings,
  titled,
  alongside = false
}: {
  app: Cutalong
  settings: Settings | null
  onSettings: (next: Settings) => void
  titled: boolean
  /** Only what Claude does with a key while a local model plans: no key steps, no cost. */
  alongside?: boolean
}): JSX.Element {
  const [changing, setChanging] = useState(false)
  const key = app.claudeKey
  const saved = app.keySaved
  // A key that worked stays in the short form while it is checked again; one that did not shows the steps.
  const working = key.state === 'ok' || (key.state === 'checking' && key.confirmed)
  const failing = key.state !== 'none' && key.state !== 'ok' && key.state !== 'checking'
  const anthropic = keyGuide('anthropic')
  const frames = settings?.claudeSeesFrames !== false
  const writes = settings?.claudeWritesUpload !== false
  const quality = planQualityOf(settings?.planQuality)
  const over = settings?.planAskOver === undefined ? ASK_OVER : settings.planAskOver
  // A local AI plans for nothing, and has no critic: what planning costs is Claude's alone.
  const pays = !alongside && !app.localAi
  const set = (patch: Partial<Settings>): void => void api.setSettings(patch).then(onSettings)

  return (
    <SetGroup title={titled ? (alongside ? 'Claude, with your key' : 'Claude') : undefined}>
      {!alongside && (
        <SetRow
          title="Anthropic key"
          tag={working ? 'Connected' : undefined}
          desc={
            working
              ? `The key is locked on ${device.here}, and in your account when you sign in, and is only ever sent to Anthropic.`
              : app.localAi
                ? `${app.localAi} edits with you now, on ${device.here}. With a key, Claude plans better.`
                : anthropic.why
          }
          find="api key claude anthropic paste"
          control={
            working ? (
              <Button small aria-expanded={changing} onClick={() => setChanging((c) => !c)}>
                {changing ? 'Done' : 'Change'}
              </Button>
            ) : undefined
          }
        >
          {working ? (
            changing && <ClaudeKeyField app={app} id="set-claude-key" removable small />
          ) : (
            <KeySteps
              service="anthropic"
              current={failing ? fixingStep(key.state) : null}
              done={failing ? doneSteps(key.state) : 0}
              paste={{ id: 'set-claude-key', field: <ClaudeKeyField app={app} id="set-claude-key" removable small watch /> }}
            />
          )}
        </SetRow>
      )}
      {!device.away['feature:vlog'] && pays && (
        <SetRow
          title="How hard I work on each edit"
          desc={
            quality !== 'quick' && !frames
              ? `The critic needs to see the edit, and frames from your footage are off below, so I plan it once. ${planQualityCost('quick')}`
              : `${PLAN_QUALITY_INFO[quality].does} ${planQualityCost(quality)}`
          }
          find="quality better critic score check redo graphics cost slower claude"
          control={
            <SetSegments
              value={quality}
              options={PLAN_QUALITIES.map((id) => ({ id, label: PLAN_QUALITY_INFO[id].label }))}
              disabled={!settings}
              onChange={(id) => set({ planQuality: id })}
            />
          }
        />
      )}
      {pays && (
        <SetRow
          title="Tell me the cost first"
          desc={
            over === null
              ? 'I price every edit and say it as I start.'
              : over === 0
                ? 'I price every edit before it starts and wait for your OK. I never go over what I said.'
                : `I price every edit before it starts, and wait for your OK on anything over ${money(over)}. I never go over what I said.`
          }
          find="price money quote confirm ask before spend claude"
          control={
            <SetSelect
              value={over === null ? 'never' : (ASKS.find((a) => a.id === String(over))?.id ?? String(ASK_OVER))}
              options={[...ASKS]}
              disabled={!settings}
              onChange={(id) => set({ planAskOver: id === 'never' ? null : Number(id) })}
            />
          }
        />
      )}
      {!device.away['feature:vlog'] && (
        <SetRow
          title="See frames from your footage"
          desc={
            !frames
              ? 'I plan from the words alone, and each moment of a vlog is described from what I measure, or by your local AI.'
              : saved
                ? `Small stills go to Claude with each plan and each moment of a vlog, so it sees what it edits. The footage stays on ${device.here}.`
                : 'With a key, small stills go to Claude with each plan and each moment of a vlog, so it sees what it edits.'
          }
          find="vlog stills pictures privacy claude"
          control={<SetSwitch checked={frames} disabled={!settings} onChange={(on) => set({ claudeSeesFrames: on })} />}
        />
      )}
      <SetRow
        title="Write titles, descriptions and tags"
        desc={
          !writes
            ? `Made on ${device.here} from your words instead.`
            : saved
              ? 'Three titles, the description’s opening and the tags for each export, from its words.'
              : `With a key. Until then they are made on ${device.here} from your words.`
        }
        find="upload youtube export claude"
        control={<SetSwitch checked={writes} disabled={!settings} onChange={(on) => set({ claudeWritesUpload: on })} />}
      />
      {!alongside && (
        <SetRow
          title="What it costs"
          desc={planCostLine(frames ? quality : 'quick')}
          find="price money spend usage cents claude"
          control={
            anthropic.spend && (
              <a className="cl-btn secondary small" href={anthropic.spend.url} target="_blank" rel="noreferrer">
                {anthropic.spend.label}
                <Icon.external />
                <span className="sr-only">, opens in your browser</span>
              </a>
            )
          }
        />
      )}
      <SpentRow alongside={alongside} />
    </SetGroup>
  )
}

/**
 * What each video has really cost, Shorts and long-form apart: from the
 * ledger of every paid call (main/costs, shared/costs), each written down
 * against the chat it was for. Where nothing is written down (a phone), it
 * does not show.
 */
function SpentRow({ alongside }: { alongside: boolean }): JSX.Element | null {
  const [summary, setSummary] = useState<CostSummary | null>(null)
  useEffect(() => {
    let live = true
    void api
      .costsSummary()
      .then((s) => live && setSummary(s))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  if (!summary?.kept || (alongside && summary.total <= 0)) return null
  const none = summary.shorts.videos + summary.long.videos === 0
  return (
    <SetRow
      title="What each video has cost"
      desc={
        none ? (
          'Nothing counted yet. From now on, every paid call is written down against the video it was for.'
        ) : (
          <>
            {averageLine(summary.shorts, 'short')}
            <br />
            {averageLine(summary.long, 'long')}
          </>
        )
      }
      find="average spent spend money dollars cents shorts long-form per video cost so far"
    />
  )
}

function LocalRows({
  settings,
  onSettings,
  server,
  looking,
  onLook,
  planner,
  onPlanner
}: {
  settings: Settings | null
  onSettings: (next: Settings) => void
  server: Server | null
  looking: boolean
  onLook: () => Promise<void>
  planner: string | null
  /** Plans with this model from now on, or with Claude when null: the app's choice, which opens its gate. */
  onPlanner: (model: string | null) => Promise<void>
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [address, setAddress] = useState('')
  useEffect(() => setAddress(settings?.localServer ?? ''), [settings?.localServer])

  const set = async (patch: Partial<Settings>): Promise<void> => onSettings(await api.setSettings(patch))
  const saveAddress = async (): Promise<void> => {
    const typed = address.trim()
    await set({ localServer: typed || null })
    setEditing(false)
    await onLook()
  }

  const models = server?.models.map((m) => m.name) ?? []
  const vision = settings?.localVision ?? null
  const seeing = models.filter((m) => SEES.test(m))
  const status = !server
    ? 'Looking…'
    : server.up
      ? `${serverName(server)} is running at ${shortHost(server.host)}, with ${models.length === 1 ? 'one model' : `${models.length} models`}.`
      : settings?.localServer
        ? `Nothing answers at ${settings.localServer}. Check the address, or that the server is on.`
        : `None is running on ${thisComputer}. Start Ollama or LM Studio and its models show up here.`
  const choices = [...new Set([...models, ...(planner ? [planner] : [])])]

  return (
    <SetGroup title="Local AI">
      <SetRow
        title="Server"
        tag={server?.up ? 'Running' : undefined}
        desc={status}
        find="local ai server ollama lm studio llama.cpp jan offline free address host port"
        control={
          <>
            <Button variant="text" small disabled={looking} onClick={() => void onLook()}>
              Look again
            </Button>
            <Button small aria-expanded={editing} onClick={() => setEditing((e) => !e)}>
              {editing ? 'Cancel' : 'Address'}
            </Button>
          </>
        }
      >
        {editing && (
          <form
            className="cl-field"
            onSubmit={(e) => {
              e.preventDefault()
              void saveAddress()
            }}
          >
            <div className="cl-row">
              <input
                aria-label="Local AI server address"
                value={address}
                placeholder="Found on its own, or localhost:1234"
                spellCheck={false}
                autoComplete="off"
                autoFocus
                onChange={(e) => setAddress(e.target.value)}
              />
              <Button small type="submit">
                Save
              </Button>
            </div>
            <p className="cl-aside">
              Ollama, LM Studio, llama.cpp’s server, Jan, or any that speaks the same chat API. Leave it empty and I
              look for Ollama, then LM Studio, on {thisComputer}.
            </p>
          </form>
        )}
        {server && !server.up && !editing && (
          <a className="cl-link" href="https://ollama.com/download" target="_blank" rel="noreferrer">
            Get Ollama
            <Icon.external />
            <span className="sr-only">, opens in your browser</span>
          </a>
        )}
      </SetRow>
      <SetRow
        title="Model"
        desc={
          choices.length === 0
            ? 'Its models show up here once the server is running.'
            : planner
              ? `${planner} plans edits, vlogs and clips.`
              : 'Pick the one that plans edits, vlogs and clips.'
        }
        find="local ai model planner offline clips vlog"
        control={
          <SetSelect
            value={planner ?? ''}
            disabled={!settings || choices.length === 0}
            options={[
              ...(planner ? [] : [{ id: '', label: choices.length === 0 ? 'None found' : 'Pick one' }]),
              ...choices.map((m) => ({ id: m, label: m }))
            ]}
            onChange={(id) => void onPlanner(id || null)}
          />
        }
      />
      {!device.away['feature:vlog'] && (
        <SetRow
          title="Sees pictures with"
          desc={
            vision
              ? `${vision} says what is in each moment of a vlog when Claude doesn’t see your frames.`
              : seeing.length > 0
                ? `When Claude doesn’t see your frames, ${seeing[0]} says what is in each moment of a vlog.`
                : 'When Claude doesn’t see your frames, a local model that sees pictures can say what is in each moment.'
          }
          find="local ai vision frames vlog llava qwen gemma pictures"
          control={
            <SetSelect
              value={vision ?? ''}
              disabled={!settings || models.length === 0}
              options={[
                { id: '', label: seeing.length ? 'Automatic' : 'None found' },
                ...[...new Set([...seeing, ...models, ...(vision ? [vision] : [])])].map((m) => ({ id: m, label: m }))
              ]}
              onChange={(id) => void set({ localVision: id || null })}
            />
          }
        />
      )}
    </SetGroup>
  )
}
