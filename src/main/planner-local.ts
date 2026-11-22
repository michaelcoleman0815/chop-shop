import { z } from 'zod'
import { EditDocSchema } from '../shared/edit'
import { thisComputer } from '../shared/platform'
import { chatLocally, isLocalUp } from './local-llm'
import { offerTrackedPlan, type PlanEditResult, type PlanInput } from './planner'
import { PLANNER_SYSTEM, PlanSchema, renderCommands, renderRequest, renderTranscript, withRealIcons } from './planner-prompt'

/**
 * The edit planner on a model on this Mac, through Ollama: free, offline,
 * and nothing leaves the computer. Claude stays the default, because a local
 * model plans less well; this is for the person who would rather it ran here.
 *
 * It gets the same instructions, transcript and request Claude does, its
 * answer is held to the same plan schema (Ollama turns the JSON Schema into
 * a grammar), checked again with zod, and then dry-run on a copy of the cut
 * exactly as Claude's is, so only ops that apply cleanly are offered.
 */

/** The plan's shape as JSON Schema, which Ollama holds the model's answer to. */
export const PLAN_JSON_SCHEMA = z.toJSONSchema(PlanSchema)

export async function planEditLocally(input: PlanInput, local: { host: string; model: string }): Promise<PlanEditResult> {
  const parsedDoc = EditDocSchema.safeParse(input.doc)
  if (!parsedDoc.success) return { ok: false, message: 'The edit could not be read.' }
  const doc = parsedDoc.data

  if (!(await isLocalUp(local.host))) {
    return {
      ok: false,
      message: `Ollama is not running on ${thisComputer}, so ${local.model} cannot plan this. Start Ollama, or plan with Claude in Settings.`
    }
  }

  let answer: unknown
  try {
    answer = await chatLocally(
      local.host,
      local.model,
      PLANNER_SYSTEM,
      [
        renderCommands(input.commands ?? []),
        renderTranscript(doc),
        renderRequest(doc, input.request, input.notes, input.voice, input.preferences ?? [], input.logos, input.never, {
          offers: input.offers,
          chat: input.chat,
          brands: input.brands,
          habits: input.habits
        }),
        // Ollama's guidance: the schema in the prompt as well grounds the answer.
        `Answer with JSON in this shape:\n${JSON.stringify(PLAN_JSON_SCHEMA)}`
      ].join('\n\n'),
      PLAN_JSON_SCHEMA
    )
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }

  const plan = PlanSchema.safeParse(answer)
  if (!plan.success) {
    return {
      ok: false,
      message: `${local.model} sent back a plan in a shape I could not read. Try again, or plan with Claude.`
    }
  }
  return offerTrackedPlan(doc, { ...plan.data, ops: await withRealIcons(plan.data.ops) }, input.notes, input.commands)
}
