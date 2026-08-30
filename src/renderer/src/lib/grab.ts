import type { Settings } from '../../../shared/types'
import type { Job } from '../components/JobList'
import { rollingBuffer } from './buffer'
import { stamp } from './format'

export async function performGrab(settings: Settings, addJob: (job: Job) => void): Promise<void> {
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const segments = await rollingBuffer.grab()

  // Grabbing in the first few seconds is a normal thing to do, and it used to
  // fail into the console where nobody would see it.
  if (!segments || segments.length === 0) {
    addJob({
      id: jobId,
      name: 'Nothing buffered yet',
      percent: 0,
      stage: 'error',
      message: rollingBuffer.getState().running
        ? 'The buffer has not held a full segment yet. Give it a few seconds.'
        : 'Start the buffer first.'
    })
    return
  }

  const name = `grab-${stamp()}`
  addJob({ id: jobId, name, percent: 0, stage: 'running' })

  await window.chop.grabBuffer({
    jobId,
    segments,
    tailSec: settings.bufferSeconds,
    aspect: settings.bufferAspect,
    name
  })
}
