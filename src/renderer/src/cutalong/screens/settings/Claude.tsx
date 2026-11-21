import { useState } from 'react'
import { doneSteps, fixingStep, keyGuide, planCostLine } from '../../../../../shared/setup'
import type { Settings } from '../../../../../shared/types'
import { api, device } from '../../api'
import { ClaudeKeyField } from '../../components/ClaudeKeyField'
import { KeySteps } from '../../components/KeySteps'
import { Button, Icon } from '../../components/ui'
import type { Cutalong } from '../../useCutalong'
import { SetGroup, SetRow, SetSwitch } from './rows'

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
  const set = (patch: Partial<Settings>): void => void api.setSettings(patch).then(onSettings)

  return (
    <SetGroup>
      <SetRow
        title="Anthropic key"
        tag={working ? 'Connected' : undefined}
        desc={
          working
            ? `Claude reads what you ask and plans each edit. The key stays on ${device.here} and only ever goes to Anthropic.`
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
      {!device.away['feature:vlog'] && (
        <SetRow
          title="See frames from your footage"
          desc={
            !frames
              ? 'Each moment of a vlog is described from what I measure, or by your local AI.'
              : saved
                ? `Three small stills a moment, to say what is in each part of a vlog. The footage stays on ${device.here}.`
                : 'With a key, three small stills a moment, to say what is in each part of a vlog.'
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
      <SetRow
        title="What it costs"
        desc={planCostLine()}
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
    </SetGroup>
  )
}
