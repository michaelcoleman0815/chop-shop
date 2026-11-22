/**
 * Who an API key belongs to, from its prefix. Only Anthropic is wired up;
 * naming the others is still better than a confusing auth failure.
 */
export type Provider = 'anthropic' | 'openai' | 'google' | 'unknown'

export function detectProvider(key: string | null): Provider {
  if (!key) return 'unknown'
  const k = key.trim()
  if (k.startsWith('sk-ant-')) return 'anthropic'
  if (k.startsWith('sk-')) return 'openai'
  if (k.startsWith('AIza')) return 'google'
  return 'unknown'
}

/** What to tell someone who pasted a key from another service, or null for a key worth trying. */
export function wrongKeyMessage(provider: Provider | string): string | null {
  const from = provider === 'openai' ? 'an OpenAI' : provider === 'google' ? 'a Google' : null
  return from ? `That looks like ${from} key. Cutalong needs one from Anthropic, which starts sk-ant-.` : null
}

/**
 * The Anthropic key in some copied text, or null: only text that is one key
 * and nothing else counts, so whatever else is on the clipboard is never taken.
 */
export function anthropicKeyIn(text: string | null | undefined): string | null {
  const k = (text ?? '').trim()
  return /^sk-ant-[A-Za-z0-9_-]{20,200}$/.test(k) ? k : null
}
