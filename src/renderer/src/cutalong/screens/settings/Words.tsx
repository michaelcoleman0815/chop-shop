import { useEffect, useState } from 'react'
import { thisComputer, ThisComputer } from '../../../../../shared/platform'
import { chosenTranscriber, servicesOn, serviceName, TRANSCRIBERS, type ServiceId } from '../../../../../shared/services'
import type { Settings } from '../../../../../shared/types'
import { api, device } from '../../api'
import { Button } from '../../components/ui'
import { grow } from '../../motion'
import { SetGroup, SetRow, SetSegments, SetSelect } from './rows'

/**
 * How the words are heard: by Whisper on this computer, at the size chosen
 * here, or by a transcription service with a key (under Services), which
 * hears every um and stutter and falls back to this computer when it cannot.
 */

type Model = Settings['whisperModel']

const MODELS: { id: Model; label: string }[] = [
  { id: 'base.en', label: 'Fast' },
  { id: 'small.en', label: 'Balanced' },
  { id: 'medium.en', label: 'Most accurate' }
].filter((m) => !device.models || device.models.includes(m.id as Model)) as { id: Model; label: string }[]

function megabytes(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`
}

export function WordsSection({
  settings,
  onSettings,
  onServices
}: {
  settings: Settings | null
  onSettings: (next: Settings) => void
  /** Opens Services, where a transcription service's key goes. */
  onServices: () => void
}): JSX.Element {
  const [ready, setReady] = useState<Partial<Record<Model, boolean>>>({})
  const [sizes, setSizes] = useState<Partial<Record<Model, number>>>({})
  const [download, setDownload] = useState<number | null>(null)
  const [keys, setKeys] = useState<Partial<Record<ServiceId, boolean>>>({})
  const on = servicesOn(settings)

  useEffect(() => {
    for (const m of MODELS) {
      void api.hasModel(m.id).then((has) => setReady((r) => ({ ...r, [m.id]: has })))
      void api.modelSizeMb(m.id).then((mb) => setSizes((s) => ({ ...s, [m.id]: mb })))
    }
    return api.onAiProgress((p) => {
      if (p.stage === 'Downloading model') setDownload(p.percent)
    })
  }, [])
  // Which services may hear the words: only asked while the switch is on.
  useEffect(() => {
    if (settings && on) void api.serviceKeys().then(setKeys)
  }, [on, Boolean(settings)])

  const set = async (patch: Partial<Settings>): Promise<void> => onSettings(await api.setSettings(patch))
  const fetchModel = async (model: Model): Promise<void> => {
    setDownload(0)
    try {
      await api.downloadModel(model)
      setReady((r) => ({ ...r, [model]: true }))
    } finally {
      setDownload(null)
    }
  }

  const model = settings?.whisperModel ?? 'small.en'
  const modelName = MODELS.find((m) => m.id === model)?.label ?? model
  const size = sizes[model]
  const hearers = on ? TRANSCRIBERS.filter((t) => keys[t.id]) : []
  const hearer = chosenTranscriber(settings, (id) => Boolean(keys[id]))
  const modelLine =
    download !== null
      ? `Downloading ${modelName}…`
      : ready[model] === undefined
        ? 'A bigger model hears more and takes longer.'
        : ready[model]
          ? `${modelName} is downloaded and ready. A bigger model hears more and takes longer.`
          : `${modelName} is ${size ? `a ${megabytes(size)} download` : 'not downloaded yet'}. I fetch it the first time it is needed, or now.`

  return (
    <SetGroup>
      <SetRow
        title="Hear the words with"
        desc={
          hearers.length === 0
            ? `${ThisComputer}, free: Whisper, then a second listen for the ums and hmms it leaves out. Deepgram or AssemblyAI, under Services, are paid.`
            : hearer
              ? `${serviceName(hearer)} hears the words in new edits. When it cannot, ${ThisComputer.toLowerCase()} does, and I say so.`
              : `${ThisComputer} hears the words in new edits, free, with a second listen for the ums and hmms Whisper leaves out.`
        }
        find="transcription transcribe whisper deepgram assemblyai"
        control={
          hearers.length === 0 ? (
            <Button small onClick={onServices}>
              Open Services
            </Button>
          ) : (
            <SetSelect
              value={hearer ?? 'local'}
              options={[{ id: 'local', label: `${ThisComputer}, free` }, ...hearers.map((t) => ({ id: t.id, label: t.name }))]}
              onChange={(id) => void set({ transcriber: id as Settings['transcriber'] })}
            />
          )
        }
      />
      <SetRow
        title={`Whisper on ${device.kind === 'phone' ? device.here : thisComputer}`}
        tag={device.kind === 'phone' ? undefined : 'Offline'}
        desc={modelLine}
        find="model transcription download size accurate fast"
        control={
          <SetSegments
            value={model}
            options={MODELS}
            disabled={!settings || download !== null}
            onChange={(id) => void set({ whisperModel: id })}
          />
        }
      >
        {download !== null ? (
          <div className="cl-progress">
            <span>Downloading {modelName}</span>
            <span className="cl-progress-bar" aria-hidden="true">
              <span style={grow(Math.max(4, Math.min(100, download)))} />
            </span>
          </div>
        ) : ready[model] === false ? (
          <Button small onClick={() => void fetchModel(model)}>
            Download {modelName} now
          </Button>
        ) : null}
      </SetRow>
    </SetGroup>
  )
}
