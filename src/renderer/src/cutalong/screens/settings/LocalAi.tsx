import { useCallback, useEffect, useState } from 'react'
import { thisComputer } from '../../../../../shared/platform'
import type { Settings } from '../../../../../shared/types'
import { api, device } from '../../api'
import { Button, Icon } from '../../components/ui'
import { SetGroup, SetRow, SetSelect } from './rows'

/**
 * Local AI in Settings: the server on this computer that runs models, found
 * on its own (Ollama, then LM Studio) or at an address typed here, and which
 * of its models plans edits and sees pictures in Claude's place. Free and
 * offline; Claude plans better, and the rows say so.
 */

type Server = Awaited<ReturnType<typeof api.localPlanners>>

/** Names that say a model sees pictures, for a server that does not say so itself. */
const SEES = /llava|vision|-vl\b|vl[:-]|qwen2\.5vl|qwen2-vl|moondream|minicpm-v|gemma-?3|bakllava|mistral-small3\.[12]|llama4/i

/** What the server is, in a word: Ollama by its own API; LM Studio at its usual port; otherwise a local server. */
function serverName(s: Server): string {
  if (s.kind === 'ollama') return 'Ollama'
  return s.host && /:1234\b/.test(s.host) ? 'LM Studio' : 'A local server'
}

const shortHost = (host: string | null): string => (host ?? '').replace(/^https?:\/\//, '')

export function LocalAiSection({
  settings,
  onSettings,
  onPlanner
}: {
  settings: Settings | null
  onSettings: (next: Settings) => void
  /** Plans with this model from now on, or with Claude when null: the app's choice, which opens its gate. */
  onPlanner: (model: string | null) => Promise<void>
}): JSX.Element {
  const [server, setServer] = useState<Server | null>(null)
  const [looking, setLooking] = useState(false)
  const [editing, setEditing] = useState(false)
  const [address, setAddress] = useState('')

  const look = useCallback(async (): Promise<void> => {
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
  useEffect(() => setAddress(settings?.localServer ?? ''), [settings?.localServer])

  const set = async (patch: Partial<Settings>): Promise<void> => onSettings(await api.setSettings(patch))
  const saveAddress = async (): Promise<void> => {
    const typed = address.trim()
    await set({ localServer: typed || null })
    setEditing(false)
    await look()
  }

  const models = server?.models.map((m) => m.name) ?? []
  const planner = settings?.localPlanner ?? null
  const vision = settings?.localVision ?? null
  const seeing = models.filter((m) => SEES.test(m))
  const status = !server
    ? 'Looking…'
    : server.up
      ? `${serverName(server)} is running at ${shortHost(server.host)}, with ${models.length === 1 ? 'one model' : `${models.length} models`}.`
      : settings?.localServer
        ? `Nothing answers at ${settings.localServer}. Check the address, or that the server is on.`
        : `None is running on ${thisComputer}. Start Ollama or LM Studio and its models show up here.`

  return (
    <SetGroup>
      <SetRow
        title="Local AI server"
        tag={server?.up ? 'Running' : undefined}
        desc={status}
        find="ollama lm studio llama.cpp jan offline free address host port"
        control={
          <>
            <Button variant="text" small disabled={looking} onClick={() => void look()}>
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
        title="Plans edits with"
        desc={
          planner
            ? `${planner} plans edits, vlogs and clips, free and offline. Claude plans them better.`
            : 'Claude plans edits, vlogs and clips. A local model is free and offline, though not as good.'
        }
        find="planner claude model offline clips vlog"
        control={
          <SetSelect
            value={planner ?? ''}
            disabled={!settings || (models.length === 0 && !planner)}
            options={[
              { id: '', label: 'Claude' },
              ...[...new Set([...models, ...(planner ? [planner] : [])])].map((m) => ({ id: m, label: m }))
            ]}
            onChange={(id) => void onPlanner(id || null).then(() => api.getSettings().then(onSettings))}
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
          find="vision frames vlog llava qwen gemma pictures"
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
