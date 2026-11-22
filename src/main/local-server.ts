import { findServer, LOCAL_SERVERS, localAddress } from './local-llm'
import { getSettings } from './store'

/**
 * The local AI server Cutalong talks to: the one at the address set in
 * Settings, or the first of Ollama and LM Studio found running. With none
 * running, the address it would use, so what goes wrong says where it looked.
 */
export async function localHost(): Promise<string> {
  const typed = getSettings().localServer ?? null
  const found = await findServer(typed)
  return found?.host ?? (typed ? (localAddress(typed) ?? LOCAL_SERVERS[0]) : LOCAL_SERVERS[0])
}
