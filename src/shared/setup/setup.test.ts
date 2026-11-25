import { describe, expect, it } from 'vitest'
import {
  blockedSentence,
  costLine,
  planQualityCost,
  doneSteps,
  fixingStep,
  gateOpen,
  guideLinks,
  KEY_GUIDES,
  KEYS_CHECKED,
  keyGuide,
  keyMessage,
  keyStateOf,
  keyStatus,
  type Blocked,
  type ClaudeKeyState,
  type KeyServiceId
} from '.'

/**
 * The key gate and the steps to every key, as the desktop app and the phone
 * app read them: nothing runs until an Anthropic key works, every state says
 * what it means and which step fixes it, and every link is the page that was
 * opened and checked.
 */

const STATES: ClaudeKeyState[] = [
  'checking',
  'ok',
  'none',
  'wrong',
  'refused',
  'no-credit',
  'no-access',
  'busy',
  'down',
  'offline',
  'unreadable'
]

describe('the gate', () => {
  it('opens only for a key that works, and stays open for a key that worked while Anthropic is busy or out of reach', () => {
    for (const state of STATES) {
      const open = gateOpen({ state, confirmed: false })
      expect(open, state).toBe(state === 'ok')
      const was = gateOpen({ state, confirmed: true })
      expect(was, `${state}, confirmed`).toBe(state === 'ok' || state === 'busy' || state === 'down' || state === 'offline')
    }
    expect(gateOpen(null)).toBe(false)
    expect(gateOpen(undefined)).toBe(false)
  })

  it('reads every answer Anthropic gives about a key', () => {
    expect(keyStateOf({ status: 401, type: 'authentication_error' })).toBe('refused')
    expect(keyStateOf({ status: 402, type: 'billing_error' })).toBe('no-credit')
    expect(keyStateOf({ status: 400, type: 'invalid_request_error', message: 'Your credit balance is too low to access the API.' })).toBe(
      'no-credit'
    )
    expect(keyStateOf({ status: 403, type: 'permission_error' })).toBe('no-access')
    expect(keyStateOf({ status: 404, type: 'not_found_error' })).toBe('no-access')
    expect(keyStateOf({ status: 429, type: 'rate_limit_error' })).toBe('busy')
    expect(keyStateOf({ status: 529, type: 'overloaded_error' })).toBe('down')
    expect(keyStateOf({ status: 500, type: 'api_error' })).toBe('down')
    expect(keyStateOf({ unreached: true })).toBe('offline')
    // A request Claude could not take says nothing about the key.
    expect(keyStateOf({ status: 400, type: 'invalid_request_error', message: 'messages: too long' })).toBeNull()
  })

  it('says each state in plain words, and marks the step that fixes it', () => {
    const steps = KEY_GUIDES.anthropic.steps
    for (const state of STATES) {
      const said = keyMessage(state)
      expect(said.length, state).toBeGreaterThan(20)
      expect(said, state).not.toMatch(/!|\b(error|401|402|403|404|429|500|529)\b/i)
      const step = fixingStep(state)
      if (step !== null) expect(steps[step], state).toBeDefined()
    }
    // Turned down: make a new key. No credit: Billing. The keychain could not open it: copy it again.
    expect(steps[fixingStep('refused') as number].link?.label).toBe('Open API keys')
    expect(steps[fixingStep('no-credit') as number].link?.label).toBe('Open Billing')
    expect(steps[fixingStep('unreadable') as number].link?.label).toBe('Open API keys')
    // Anthropic being down or out of reach is not fixed by any step.
    expect(fixingStep('down')).toBeNull()
    expect(fixingStep('offline')).toBeNull()
    // Done only where Anthropic accepted the key: always before the step that fixes what is left.
    for (const state of STATES) {
      const done = doneSteps(state)
      if (done > 0) expect(done, state).toBeLessThanOrEqual(fixingStep(state) as number)
    }
    // Out of credit: the first step, signing in and paying, is the one to do again.
    expect(doneSteps('no-credit')).toBe(0)
    expect(doneSteps('no-access')).toBe(1)
    for (const state of ['none', 'wrong', 'refused', 'unreadable', 'down', 'offline'] as const) expect(doneSteps(state), state).toBe(0)
    expect(keyStatus('refused')).toEqual({ state: 'refused', message: keyMessage('refused'), confirmed: false })
    expect(keyMessage('wrong', 'sk-proj-abc123abc123abc123')).toMatch(/OpenAI/)
  })

  it('says in one sentence why anything stopped, and where the steps are', () => {
    const kinds: Blocked[] = ['footage', 'words', 'command', 'notes', 'export', 'link', 'edit', 'learn']
    for (const what of kinds) {
      const said = blockedSentence(what, keyStatus('none'))
      expect(said, what).toMatch(/^I need an Anthropic key before I can [a-z ]+\. Start shows the steps\.$/)
    }
    expect(blockedSentence('footage', keyStatus('none'), 'here')).toBe(
      'I need an Anthropic key before I can read footage. Follow the steps here, then try again.'
    )
    expect(blockedSentence('export', keyStatus('no-credit'))).toBe(
      'I need credit on your Anthropic account before I can export. Start shows the steps.'
    )
    expect(blockedSentence('words', keyStatus('refused'))).toBe(
      'I need an Anthropic key that works before I can work on what you ask. Start shows the steps.'
    )
  })
})

describe('the steps to every key', () => {
  // Each page opened and read on the day KEYS_CHECKED says, from the service's own documentation.
  const CHECKED: Record<KeyServiceId, string[]> = {
    anthropic: [
      'https://platform.claude.com/settings/billing',
      'https://platform.claude.com/settings/keys',
      'https://platform.claude.com/usage'
    ],
    gemini: ['https://aistudio.google.com/apikey', 'https://aistudio.google.com/projects'],
    fal: ['https://fal.ai/dashboard/keys', 'https://fal.ai/dashboard/billing'],
    elevenlabs: [
      'https://elevenlabs.io/app/sign-up',
      'https://elevenlabs.io/app/settings/api-keys',
      'https://elevenlabs.io/app/subscription'
    ],
    deepgram: ['https://console.deepgram.com/signup', 'https://console.deepgram.com/'],
    assemblyai: ['https://www.assemblyai.com/dashboard/signup', 'https://www.assemblyai.com/dashboard/home']
  }

  it('has a guide for each service, every link the page that was checked', () => {
    expect(KEYS_CHECKED).toBe('2026-11-16')
    expect(Object.keys(KEY_GUIDES).sort()).toEqual(Object.keys(CHECKED).sort())
    for (const [id, urls] of Object.entries(CHECKED) as [KeyServiceId, string[]][]) {
      const guide = keyGuide(id)
      const links = [...guide.steps.flatMap((s) => (s.link ? [s.link.url] : [])), ...(guide.spend ? [guide.spend.url] : [])]
      expect(links, id).toEqual(urls)
    }
    for (const link of guideLinks()) {
      expect(new URL(link.url).protocol).toBe('https:')
      expect(link.label).toMatch(/^Open /)
    }
  })

  it('ends every guide on pasting the key, and Anthropic’s on copying it, and says what the key is for', () => {
    for (const guide of Object.values(KEY_GUIDES)) {
      if (guide.id !== 'anthropic') expect(guide.steps.at(-1)?.text, guide.id).toBe('Paste the key here.')
      expect(guide.steps.length, guide.id).toBeLessThanOrEqual(4)
      expect(guide.why, guide.id).toMatch(/^[A-Z].+\.$/)
      for (const step of guide.steps) expect(step.text, guide.id).toMatch(/^[A-Z].+\.$/)
    }
    // Only what the person has to do themselves: sign in and pay, then make the key and copy it.
    // The desktop app picks the copied key up; the field in the last step is for pasting it.
    expect(KEY_GUIDES.anthropic.steps.map((s) => s.text)).toEqual([
      'Sign in to the Anthropic Console, or sign up, and add credit.',
      'Create a key named Cutalong, and copy it.'
    ])
  })

  it('says what a plan costs in one line, from the published prices, and where to see the spend', () => {
    expect(costLine()).toBe(
      'A plan on a 10-minute video costs about 6 to 55 cents at Anthropic’s prices on 16 November 2026. The Console’s Usage page shows what you actually spend.'
    )
    // Beside the choice of how hard to work, what more it costs.
    expect(planQualityCost('quick')).toBe('A plan costs up to about 55 cents.')
    expect(planQualityCost('careful')).toBe('It costs more on your Anthropic account: up to about 80 cents a plan, where Quick is up to about 55 cents.')
    expect(planQualityCost('best')).toBe('It costs more on your Anthropic account: up to about $1.25 a plan, where Quick is up to about 55 cents.')
  })
})
