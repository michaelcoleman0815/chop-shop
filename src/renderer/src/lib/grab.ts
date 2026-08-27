import type { Settings } from '../../../shared/types'
import type { Job } from '../components/JobList'
import { rollingBuffer } from './buffer'
import { stamp } from './format'

export async function performGrab(settings: Settings, addJob: (job: Job) => void): Promise<void> {
  const segments = await rollingBuffer.grab()
  if (!segments || segments.length === 0) return

  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const name = `grab-${stamp()}`
  addJob({ id: jobId, name, percent: 0, stage: 'running' })

  await window.chop.grabBuffer({
    jobId,
    segments,
    tailSec: settings.bufferSeconds,
    aspect: settings.defaultAspect,
    name
  })
}
