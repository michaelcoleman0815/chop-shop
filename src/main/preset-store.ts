import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { BUILT_IN_PRESETS, CAPTION_STYLE_PRESETS, PresetSchema, SKILL_PRESETS, type Preset } from '../shared/presets'

/**
 * Saved slash commands: the styles people keep from videos they liked. A small
 * JSON file in userData; anything in it that no longer validates is skipped
 * rather than breaking the slash menu.
 */

const file = (): string => join(app.getPath('userData'), 'presets.json')

export async function savedPresets(): Promise<Preset[]> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(file(), 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw.flatMap((p) => {
      const r = PresetSchema.safeParse(p)
      return r.success && !r.data.builtIn ? [r.data] : []
    })
  } catch {
    return []
  }
}

async function write(presets: Preset[]): Promise<void> {
  // Written beside the real file and renamed over it, so a crash mid-write
  // leaves the old list rather than half of a new one.
  const tmp = `${file()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(presets, null, 2))
  await fs.rename(tmp, file())
}

export async function savePreset(
  preset: unknown
): Promise<{ ok: true; presets: Preset[] } | { ok: false; message: string }> {
  const parsed = PresetSchema.safeParse(preset)
  if (!parsed.success) return { ok: false, message: 'That style is not in a shape I can save.' }
  const next: Preset = { ...parsed.data, builtIn: false }
  if ([...BUILT_IN_PRESETS, ...CAPTION_STYLE_PRESETS, ...SKILL_PRESETS].some((b) => b.command === next.command)) {
    return { ok: false, message: `/${next.command} is built in. Pick another name.` }
  }
  const presets = [...(await savedPresets()).filter((p) => p.command !== next.command), next]
  await write(presets)
  return { ok: true, presets }
}

export async function removePreset(command: string): Promise<Preset[]> {
  const presets = (await savedPresets()).filter((p) => p.command !== command)
  await write(presets)
  return presets
}
