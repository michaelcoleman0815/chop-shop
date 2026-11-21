import { brollKeyService, type BrollKeyId } from '../../shared/broll/keys'
import type { KeyCheck } from '../../shared/services'
import { HttpError, type Http } from './http'

/**
 * Whether a saved B-roll key works, asked of its site with the cheapest
 * request it has, for Settings to show next to the key. A refusal says the
 * key is wrong; anything else says the site could not be asked.
 */

export async function checkBrollKey(id: BrollKeyId, deps: { http: Http; read: (id: BrollKeyId) => string | null }): Promise<KeyCheck> {
  const key = deps.read(id)
  const name = brollKeyService(id).name
  if (!key) return { ok: false, state: 'none', message: `No ${name} key is saved.` }
  const ask: Record<BrollKeyId, () => Promise<unknown>> = {
    pexels: () => deps.http.json('https://api.pexels.com/v1/curated?per_page=1', { headers: { authorization: key }, retries: 0 }),
    pixabay: () => deps.http.json(`https://pixabay.com/api/?${new URLSearchParams({ key, q: 'sky', per_page: '3' })}`, { retries: 0 }),
    unsplash: () =>
      deps.http.json('https://api.unsplash.com/photos?per_page=1', {
        headers: { authorization: `Client-ID ${key}`, 'accept-version': 'v1' },
        retries: 0
      }),
    giphy: () => deps.http.json(`https://api.giphy.com/v1/gifs/trending?${new URLSearchParams({ api_key: key, limit: '1' })}`, { retries: 0 }),
    freesound: () =>
      deps.http.json(`https://freesound.org/apiv2/search/text/?${new URLSearchParams({ query: 'click', page_size: '1' })}`, {
        headers: { authorization: `Token ${key}` },
        retries: 0
      })
  }
  try {
    await ask[id]()
    return { ok: true }
  } catch (err) {
    if (err instanceof HttpError && (err.status === 401 || err.status === 403 || err.status === 400))
      return { ok: false, state: 'refused', message: `${name} turned that key down. Copy it again from ${brollKeyService(id).signUp}.` }
    return { ok: false, state: 'unchecked', message: `${name} could not be asked just now, so the key is saved but not checked.` }
  }
}
