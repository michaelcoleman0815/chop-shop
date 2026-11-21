/**
 * First run: whether onboarding has been seen, and what the rail's setup card
 * still asks for. Both are remembered on this computer only; forgetting them
 * just shows the welcome again.
 */

const ONBOARDED = 'cutalong:onboarded'
const EXPORTED = 'cutalong:exported'

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function write(key: string): void {
  try {
    localStorage.setItem(key, '1')
  } catch {
    // Remembering is a convenience: without storage the welcome shows again next time.
  }
}

export const onboarded = (): boolean => read(ONBOARDED)
export const markOnboarded = (): void => write(ONBOARDED)
export const exportedOnce = (): boolean => read(EXPORTED)
export const markExported = (): void => write(EXPORTED)

export type SetupStepId = 'key' | 'channel' | 'first' | 'export'

export interface SetupStep {
  id: SetupStepId
  label: string
  done: boolean
}

/** What setup still asks for, in order. The card goes once every step is done. */
export function setupSteps(state: { keyWorks: boolean; named: boolean; edits: number; exported: boolean }): SetupStep[] {
  return [
    { id: 'key', label: 'Add your Anthropic key', done: state.keyWorks },
    { id: 'channel', label: 'Name your channel', done: state.named },
    { id: 'first', label: 'Make your first edit', done: state.edits > 0 },
    { id: 'export', label: 'Export once', done: state.exported }
  ]
}
