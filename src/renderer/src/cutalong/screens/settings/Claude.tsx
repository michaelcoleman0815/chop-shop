import { useState } from 'react'
import { PLAN_QUALITIES, PLAN_QUALITY_INFO, planQualityOf } from '../../../../../shared/plan-quality'
import { ASK_OVER, doneSteps, fixingStep, keyGuide, money, planCostLine, planQualityCost } from '../../../../../shared/setup'
import type { Settings } from '../../../../../shared/types'
import { api, device } from '../../api'
import { ClaudeKeyField } from '../../components/ClaudeKeyField'
import { KeySteps } from '../../components/KeySteps'
import { Button, Icon } from '../../components/ui'
import type { Cutalong } from '../../useCutalong'
import { SetGroup, SetRow, SetSegments, SetSelect, SetSwitch } from './rows'

/** What an edit may come to before it waits for a yes, in dollars. */
const ASKS = [
  { id: '0', label: 'Always ask' },
  { id: String(ASK_OVER), label: `Ask over ${money(ASK_OVER)}` },
  { id: '0.5', label: 'Ask over 50 cents' },
  { id: 'never', label: 'Don’t ask' }
] as const

/**
 * Claude in Settings: the Anthropic key, what Claude may see and write, and
 * what a plan costs. Which model plans edits instead, on this computer, is
 * under Local AI.
 */
export function ClaudeSection({
  app,
  settings,
  onSettings
}: {
  app: Cutalong
  settings: Settings | null
  onSettings: (next: Settings) => void
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
  const set = (patch: Partial<Settings>): void => void api.setSettings(patch).then(onSettings)

  return (
    <SetGroup>
      <SetRow
        title="Anthropic key"
        tag={working ? 'Connected' : undefined}
        desc={
          working
            ? `Claude reads what you ask and plans each edit. The key is locked on ${device.here}, and in your account when you sign in, and is only ever sent to Anthropic.`
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
      {/* Claude's alone: a local AI plans for nothing, and has no critic. */}
      {!device.away['feature:vlog'] && !app.localAi && (
        <SetRow
          title="How hard I work on each edit"
          desc={
            quality !== 'quick' && !frames
              ? `The critic needs to see the edit, and frames from your footage are off below, so I plan it once. ${planQualityCost('quick')}`
              : `${PLAN_QUALITY_INFO[quality].does} ${planQualityCost(quality)}`
          }
          find="quality better critic score check redo graphics cost slower"
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
      {!app.localAi && (
        <SetRow
          title="Tell me the cost first"
          desc={
            over === null
              ? 'I price every edit and say it as I start.'
              : over === 0
                ? 'I price every edit before it starts and wait for your OK. I never go over what I said.'
                : `I price every edit before it starts, and wait for your OK on anything over ${money(over)}. I never go over what I said.`
          }
          find="price money quote confirm ask before spend"
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
          find="vlog stills pictures privacy"
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
        find="upload youtube export"
        control={<SetSwitch checked={writes} disabled={!settings} onChange={(on) => set({ claudeWritesUpload: on })} />}
      />
      {!app.localAi && (
        <SetRow
          title="What it costs"
          desc={planCostLine(frames ? quality : 'quick')}
          find="price money spend usage cents"
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
    </SetGroup>
  )
}
