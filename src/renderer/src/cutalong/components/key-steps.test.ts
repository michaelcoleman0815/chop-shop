import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { KEY_GUIDES, keyMessage, keyStatus, type ClaudeKeyStatus, type KeyServiceId } from '../../../../shared/setup'
import type { Cutalong } from '../useCutalong'
import { ClaudeKeyField } from './ClaudeKeyField'
import { aKey, KeySteps } from './KeySteps'

/**
 * The steps to a key as every screen shows them (KeySteps): Start's setup,
 * Settings, and a feature that needs a key. Each step is numbered, each page
 * is a link that opens in the browser and says so to a screen reader, the
 * last step holds the field with its label, and the step that fixes what
 * went wrong is the one marked.
 */

const render = (
  service: KeyServiceId,
  extra: { current?: number | null; done?: number; paste?: { id: string; field: unknown } } = {}
): string =>
  renderToStaticMarkup(createElement(KeySteps, { service, ...extra } as Parameters<typeof KeySteps>[0]))

describe('the steps to a key', () => {
  it('shows every service’s steps, with each page as a link that opens in the browser', () => {
    for (const guide of Object.values(KEY_GUIDES)) {
      const html = render(guide.id)
      expect(html).toContain(`aria-label="How to get ${aKey(guide.name)}"`)
      const items = html.match(/<li/g) ?? []
      expect(items, guide.id).toHaveLength(guide.steps.length)
      // Numbered by the list itself (the design system's .cl-steps), each step what to do as its heading.
      expect(html, guide.id).toMatch(/^<ol class="cl-steps" role="list"/)
      for (const step of guide.steps) {
        expect(html, guide.id).toContain(`<div class="cl-step-body"><h3>${step.text}`)
        if (!step.link) continue
        expect(html, guide.id).toContain(
          `<a class="cl-btn secondary small cl-step-link" href="${step.link.url.replace(/&/g, '&amp;')}" target="_blank" rel="noreferrer">${step.link.label}`
        )
      }
      expect((html.match(/, opens in your browser/g) ?? []).length, guide.id).toBe(guide.steps.filter((s) => s.link).length)
    }
  })

  it('says “a” or “an” as the name is said', () => {
    expect(aKey('Anthropic')).toBe('an Anthropic key')
    expect(aKey('fal.ai')).toBe('a fal.ai key')
    expect(aKey('ElevenLabs')).toBe('an ElevenLabs key')
    expect(aKey('Google Gemini')).toBe('a Google Gemini key')
  })

  it('holds the field in the last step, labelled by it, and marks the step that fixes what went wrong', () => {
    const html = render('anthropic', {
      current: 2,
      done: 2,
      paste: { id: 'cl-key', field: createElement('input', { id: 'cl-key', type: 'password' }) }
    })
    expect(html).toContain('<h3><label for="cl-key">Paste the key here.</label></h3>')
    expect(html).toContain('<div class="cl-step-field"><input id="cl-key" type="password"/></div>')
    expect(html.match(/aria-current="step"/g)).toHaveLength(1)
    expect(html).toMatch(/<li class="now" aria-current="step"><div class="cl-step-body"><h3>Add credit under Billing/)
    // The steps before it are done, and say so to a screen reader too.
    expect(html.match(/<li class="done">/g)).toHaveLength(2)
    expect(html).toContain('<h3>Create a key, name it Cutalong, and copy it.<span class="sr-only">, done</span></h3>')
    // Nothing marked when nothing went wrong.
    const plain = render('anthropic')
    expect(plain).not.toContain('aria-current')
    expect(plain).not.toContain('class="done"')
  })
})

/**
 * The field an Anthropic key is pasted into, in the design system's field
 * states (.cl-field, .cl-field-msg): a failed check makes the field invalid
 * and says what went wrong in the error colour beside an alert icon; a key
 * that works says so in the ok colour beside a check. Never colour alone.
 */
describe('the field a key is pasted into', () => {
  const field = (status: ClaudeKeyStatus, extra: { showOk?: boolean; note?: string; saved?: boolean } = {}): string => {
    const app = {
      claudeKey: status,
      keySaved: extra.saved ?? status.state !== 'none',
      saveClaudeKey: async () => status,
      checkClaudeKey: async () => status,
      removeClaudeKey: async () => {}
    } as unknown as Cutalong
    return renderToStaticMarkup(
      createElement(ClaudeKeyField, { app, id: 'cl-key', showOk: extra.showOk, note: extra.note ?? null })
    )
  }

  it('marks a failed check as an error on the field and its line', () => {
    for (const state of ['refused', 'no-credit', 'no-access', 'busy', 'down', 'offline', 'unreadable', 'wrong'] as const) {
      const html = field(keyStatus(state, false, 'sk-proj-abc'))
      expect(html, state).toContain('aria-invalid="true"')
      expect(html, state).toMatch(/<p id="cl-key-line" class="cl-field-msg cl-keycheck error" role="status"><svg/)
      expect(html, state).toContain(keyMessage(state, 'sk-proj-abc'))
    }
  })

  it('says a working key works beside a check, where it is asked to', () => {
    const html = field(keyStatus('ok', true), { showOk: true })
    expect(html).not.toContain('aria-invalid')
    expect(html).toMatch(/<p id="cl-key-line" class="cl-field-msg cl-keycheck ok" role="status"><svg/)
    expect(html).toContain(keyMessage('ok'))
    // On the setup screen the screen moves on instead, so nothing is said.
    expect(field(keyStatus('ok', true))).toContain('<p id="cl-key-line" class="cl-field-msg cl-keycheck" role="status"></p>')
  })

  it('marks nothing with no key, while checking, or when a sentence stands in for the check', () => {
    for (const html of [
      field(keyStatus('none')),
      field(keyStatus('checking')),
      field(keyStatus('refused'), { note: 'I need an Anthropic key before I can read footage. Follow the steps here, then try again.' })
    ]) {
      expect(html).not.toContain('aria-invalid')
      expect(html).not.toMatch(/cl-keycheck (error|ok)/)
    }
  })
})
