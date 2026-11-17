import { thisComputer } from '../../../../shared/platform'
import type { Settings } from '../../../../shared/types'
import { api } from '../api'

/**
 * Whether Claude may see stills from the footage, to say what is in each
 * moment of a vlog. On unless turned off, and nothing is sent without a key:
 * then a model on this Mac that sees pictures says it, or the measurements do.
 */
export function ClaudeFrames({
  settings,
  hasKey,
  onSettings
}: {
  settings: Settings | null
  hasKey: boolean
  onSettings: (next: Settings) => void
}): JSX.Element {
  const on = settings?.claudeSeesFrames !== false
  const line = !on
    ? `Claude sees no frames. I say what is in each moment from what I measure, or with a model on ${thisComputer} that can see pictures.`
    : hasKey
      ? 'When I make a vlog, Claude sees three small stills from each moment to say what is in it. The footage stays on this computer.'
      : 'With a key, Claude sees three small stills from each moment of a vlog to say what is in it. The footage stays on this computer.'
  return (
    <div className="cl-field">
      <label className="cl-toggle">
        <input
          type="checkbox"
          role="switch"
          checked={on}
          aria-checked={on}
          disabled={!settings}
          onChange={(e) => void api.setSettings({ claudeSeesFrames: e.target.checked }).then(onSettings)}
        />
        Let Claude see frames from my footage
      </label>
      <p className="cl-aside" role="status">
        {line}
      </p>
    </div>
  )
}

/**
 * Whether Claude writes each export's titles, the description's opening and
 * its tags. On unless turned off, and nothing is sent without a key: then
 * they are made on this computer from the words (main/upload-kit).
 */
export function ClaudeWrites({
  settings,
  hasKey,
  onSettings
}: {
  settings: Settings | null
  hasKey: boolean
  onSettings: (next: Settings) => void
}): JSX.Element {
  const on = settings?.claudeWritesUpload !== false
  const line = !on
    ? 'I make the titles, the description and the tags for each export from your words, on this computer.'
    : hasKey
      ? 'When you export, Claude reads the words of the video and writes three titles, the description’s opening and the tags. The footage stays on this computer.'
      : 'With a key, Claude writes three titles, the description’s opening and the tags for each export from its words. Until then I make them on this computer.'
  return (
    <div className="cl-field">
      <label className="cl-toggle">
        <input
          type="checkbox"
          role="switch"
          checked={on}
          aria-checked={on}
          disabled={!settings}
          onChange={(e) => void api.setSettings({ claudeWritesUpload: e.target.checked }).then(onSettings)}
        />
        Let Claude write titles, descriptions and tags
      </label>
      <p className="cl-aside" role="status">
        {line}
      </p>
    </div>
  )
}
