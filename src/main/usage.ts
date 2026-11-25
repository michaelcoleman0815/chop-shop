import type { ApiUsage, Purpose } from '../shared/costs'

/**
 * Where a paid call says what it used. Each place that calls Claude takes a
 * ticket as the call starts (so it is written against the chat that was open
 * then, even if another opens before the answer comes back) and hands the
 * answer's model and usage to it. On the Mac, main/costs takes the tickets
 * and keeps the ledger; anywhere nothing does (the phone, tests), a ticket
 * does nothing. Kept free of Electron so the phone can share the callers.
 */

export type UsageTicket = (model: string | null | undefined, usage: ApiUsage | null | undefined) => void

export type UsageSink = (purpose: Purpose) => UsageTicket

let sink: UsageSink | null = null

export function setUsageSink(next: UsageSink | null): void {
  sink = next
}

const nothing: UsageTicket = () => undefined

/** A ticket for a call about to go. Never throws: what a call cost is never a reason for it to fail. */
export function usageTicket(purpose: Purpose): UsageTicket {
  if (!sink) return nothing
  try {
    const ticket = sink(purpose)
    return (model, usage) => {
      try {
        if (model) ticket(model, usage)
      } catch {
        // The ledger is a record, not part of the work.
      }
    }
  } catch {
    return nothing
  }
}
