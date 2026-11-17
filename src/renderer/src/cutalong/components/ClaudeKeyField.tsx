import { useRef, useState } from 'react'
import { gateOpen, keyGuide, keyMessage, type ClaudeKeyStatus } from '../../../../shared/setup'
import type { Cutalong } from '../useCutalong'
import { Button, Icon, Mark } from './ui'

/** Where the key goes once pasted, said beside the field. */
export const KEY_KEPT = 'The key is locked in this computer’s keychain and only ever sent to Anthropic.'

/**
 * The field an Anthropic key is pasted into, and what its check found, on
 * the setup screen and in Settings: the one primary button checks and saves
 * a pasted key; a saved key that failed can be checked again once its cause
 * is fixed (credit added, Anthropic back). What went wrong is said under the
 * field, in the words the gate has for it (shared/setup/gate.ts).
 */
export function ClaudeKeyField({
  app,
  id,
  note = null,
  showOk = false,
  removable = false,
  small = false,
  autoFocus = false,
  onCheck,
  onWorks
}: {
  app: Cutalong
  /** The input's id, which the step's label points at. */
  id: string
  /** A sentence that stands in for the check's, such as footage dropped while there is no key. */
  note?: string | null
  /** Say so when the key works (Settings); the setup screen is gone by then. */
  showOk?: boolean
  removable?: boolean
  small?: boolean
  autoFocus?: boolean
  /** A check begins: whatever stood in for its sentence goes. */
  onCheck?: () => void
  onWorks?: () => void
}): JSX.Element {
  const guide = keyGuide('anthropic')
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const key = app.claudeKey
  const checking = saving || key.state === 'checking'
  const failing = !checking && key.state !== 'none' && key.state !== 'ok'
  const saved = app.keySaved
  const pasted = draft.trim()

  const run = async (check: () => Promise<ClaudeKeyStatus>): Promise<void> => {
    if (checking) return
    onCheck?.()
    setSaving(true)
    const next = await check()
    setSaving(false)
    if (gateOpen(next)) onWorks?.()
    // The button pressed was turned off while the check ran: keyboard focus comes back to the field, for the next key.
    else field.current?.focus()
  }

  const save = (): void => {
    if (!pasted) return
    setDraft('')
    void run(() => app.saveClaudeKey(pasted))
  }

  const line = checking
    ? keyMessage('checking')
    : (note ?? (failing ? key.message : showOk && key.state === 'ok' ? key.message : null))
  // The state the line says, for the design system's field states: what went wrong, or that the key works.
  const kind = checking || note ? null : failing ? 'error' : showOk && key.state === 'ok' ? 'ok' : null

  return (
    <div className="cl-field">
      <div className={`cl-key-paste${small ? ' small' : ''}`}>
        <input
          ref={field}
          id={id}
          type="password"
          value={draft}
          placeholder={saved ? 'Paste a new key to replace this one' : guide.looksLike}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          aria-invalid={kind === 'error' ? true : undefined}
          aria-describedby={`${id}-line ${id}-kept`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
          }}
        />
        <Button variant="primary" small={small} disabled={checking || !pasted} onClick={save}>
          Check and save
        </Button>
        {removable && saved && (
          <Button variant="text" disabled={checking} onClick={() => void app.removeClaudeKey()}>
            Remove
          </Button>
        )}
      </div>
      <p
        id={`${id}-line`}
        className={`cl-field-msg cl-keycheck${kind ? ` ${kind}` : ''}${checking ? ' checking' : ''}`}
        role="status"
      >
        {checking && (
          <span className="cl-keycheck-mark" aria-hidden="true">
            <Mark size={20} />
          </span>
        )}
        {/* The words say the state, and the colour and the icon say it again. */}
        {kind === 'error' && <Icon.alert />}
        {kind === 'ok' && <Icon.check />}
        {/* Keyed by its words, so a new finding arrives rather than replacing the old in place. */}
        {line && <span key={line}>{line}</span>}
      </p>
      {/* A saved key that failed can be tried again once what stopped it is fixed. */}
      {failing && saved && key.state !== 'wrong' && !note && (
        <Button small className="cl-keycheck-again" onClick={() => void run(() => app.checkClaudeKey())}>
          Check again
        </Button>
      )}
      <p id={`${id}-kept`} className="cl-key-kept">
        {KEY_KEPT}
      </p>
    </div>
  )
}
