import { z } from 'zod'
import { applyOps, currentCut, resolveCut, roomOps, type Cut, type EditDoc } from '../shared/edit'
import type { Direction } from '../shared/motion/direction'
import { FONT_FAMILIES } from '../shared/motion/fonts'
import { LayerInputSchema, type LayerInput } from '../shared/motion/schema'
import { directed, themeFrom } from '../shared/motion/theme'
import { sceneForCut } from './motion-scene'
import type { PlannerOp } from './planner-prompt'

/**
 * The designer: a graphic drawn for one moment of one video rather than picked from the templates. At the best
 * quality the plan may ask for a few, each with a brief (what it has to make clear, and the idea); a designer who
 * sees the shot it goes on, the words and when each is said, and the video's art direction builds it from shapes,
 * words, icons, brands' marks and keyframes, as the templates themselves are built. The critic judges it with the rest.
 */

/** The most a plan may have designed: one, for the moment the video turns on. A designer is the dearest call there is. */
export const MAX_DESIGNS = 1
/** How many times what was designed may be drawn again when the critic turned it down. */
export const MAX_REDESIGNS = 1

/** A design asked for in a plan, and what was made of it. */
export interface DesignOp {
  op: 'design'
  from: string
  to: string
  room: 'left' | 'right' | 'foot' | 'full' | 'over'
  brief: string
  layers?: LayerInput[]
}
export const isDesign = (o: unknown): o is DesignOp => (o as { op?: string }).op === 'design'

export const GRAPHIC_TOOL = 'graphic'
export const GRAPHIC_DESCRIPTION = 'Hand over the graphic: one sentence saying the idea, and its layers, bottom first.'
export const GRAPHIC_SCHEMA = {
  type: 'object' as const,
  properties: {
    idea: { type: 'string', description: 'The idea in one sentence.' },
    layers: { type: 'array', items: { type: 'object' }, description: 'The layers, bottom first, as described.' }
  },
  required: ['idea', 'layers']
}

export const DESIGN_SYSTEM = `You are a motion designer. You are given one moment of one video: the shot, the words being said and when, what the graphic has to make clear, and the video's art direction. You design one graphic for it, from nothing, and hand it over with the ${GRAPHIC_TOOL} tool. It is drawn over the footage exactly as you describe it.

## What makes it good
- One idea, seen at once, that tells the viewer something. Draw the real thing being explained: who pays whom, what a figure comes to beside another, the parts of a product apart, a change over time. Never a figure of speech made into an object (no wheel for "spinning your wheels", no finish line for "the race"): if a stranger would ask why it is there, it is wrong. Not a card with a sentence on it, not an icon over a word, not a list.
- It could only be in this video. Use its own things: the brands named, the numbers said, the objects in the shot, the art direction's idea. Nothing that is not said: no invented figure, date, quote or name.
- It is built, not placed. Draw objects from several shapes with light on them: a gradient for the lit side, a darker edge, a soft shadow under it, a thin highlight. Flat single-colour blobs look like clip art.
- Few words, big. A phone at arm's length: nothing under 34 px on a 1080-high frame; the main word or figure 90 to 260.
- It sits in its room, uses most of it, lines up, and leaves the rest of the picture alone. Never over a face.
- It moves softly, as the best do (measured on their videos): each thing drifts up 50 to 100 px on "out-quint" over 1.4 to 2 s while it fades in over 0.4 s on "in-out-quad", one after another on the words, with a moment of stillness before the next; strokes draw on with trim over 0.8 to 1 s on "in-out-cubic"; what matters lands last. Nothing pops, bounces, overshoots, spins for the sake of it, or crosses more than about 8% of the frame's width in a frame. It may keep one slow thing moving (a drift, pieces travelling a line). It does not need to leave: the whole graphic is moved off the frame at its end for you (off to its side, down out of the foot, or pushed through), so give nothing a fade or a move at the end.

## The canvas
Pixels of the full frame, (0, 0) top left. Layers are drawn in order, bottom first. A layer's "start" and "end" are seconds from the graphic's start; leave both out to last its whole life. Keyframe times ("t") are seconds from the layer's own start; add "from": "end" to count back from its end.
Every layer may have:
- "transform": {"x", "y" (where its own origin goes), "anchorX", "anchorY" (the point it turns and grows about, in its own pixels), "scale", "scaleX", "scaleY", "rotation" (degrees), "skewX", "skewY", "opacity"}. Each is a number or {"keys": [{"t": 0, "v": 0, "ease": "out-quart"}, {"t": 0.5, "v": 1}]}. "ease" shapes the move from that key to the next: linear, hold, out-quad, out-cubic, out-quart, out-quint, in-out-quad, in-out-cubic, in-out-quart, in-quad, in-cubic, back-out.
- "effects": {"shadow": {"color", "blur", "x", "y"}, "glow": {"color", "blur", "strength"}, "blur": number or keys}.
- "mask": {"shape": a shape, "transform", "invert"}: it shows only inside the shape.
- "blend": "screen", "multiply", "overlay", "add".
Kinds:
- {"kind": "shape", "shape": S, "fill": F, "stroke": {"color", "width", "cap": "round", "join": "round", "dash": [on, off]}, "trim": {"start", "end"} (0 to 1, keys draw the stroke on)}. S is {"type": "rect", "w", "h", "radius"} or {"type": "ellipse", "w", "h", "startAngle", "sweep"} centred on the layer's origin; {"type": "line", "points": [[x, y], ...]}; {"type": "arrow", "points", "head"}; {"type": "polygon", "points"}; {"type": "path", "d": SVG path data}. F is "#RRGGBB", "rgba(r, g, b, a)" or {"gradient": "linear", "angle": 90, "stops": [[0, "#..."], [1, "#..."]]} (angle 0 runs left to right, 90 top to bottom) or {"gradient": "radial", "stops"}.
- {"kind": "text", "text", "font": {"family", "size", "tracking", "lineHeight", "uppercase", "tabular"}, "fill", "stroke": {"color", "width"}, "align": "left"|"center"|"right", "valign": "middle"|"top"|"bottom", "maxWidth", "count": {"from", "to", "decimals", "prefix", "suffix", "group", "progress": keys 0 to 1} (a number counting), "animators": [{"by": "char"|"word"|"line", "delay", "stagger", "duration", "ease", "from": {"opacity", "x", "y", "scale", "blur"}}]}. Families: ${FONT_FAMILIES.join(', ')}.
- {"kind": "image", "icon": a Lucide name, "w", "h", "color", "strokeWidth", "iconFill", "trim"}, or {"kind": "image", "logo": a Simple Icons slug ("google", "apple", "openai", "youtube"), "tile": "square"|"round", "w", "h", "fallback": {"text", "family"}}: centred on its origin.
- {"kind": "group", "children": [layers]}: a group's transform carries its children; children are placed in the group's own pixels. Use one to grow, turn, dim or mask several things together.
At most about 60 layers and 14,000 characters. Numbers with no more than two decimals.

## An example of the craft (a coin dropping into a slot, 1920 by 1080, left room)
[{"kind":"shape","shape":{"type":"rect","w":1150,"h":1080},"fill":{"gradient":"linear","angle":0,"stops":[[0,"rgba(6,7,10,0.9)"],[0.6,"rgba(6,7,10,0.6)"],[1,"rgba(6,7,10,0)"]]},"transform":{"x":575,"y":540,"opacity":{"keys":[{"t":0,"v":0,"ease":"out-quad"},{"t":0.3,"v":1},{"t":0.2,"v":1,"from":"end"},{"t":0,"v":0,"from":"end"}]}}},
{"kind":"group","transform":{"x":430,"y":{"keys":[{"t":0.5,"v":250,"ease":"in-cubic"},{"t":0.95,"v":560}]},"opacity":{"keys":[{"t":0.4,"v":0},{"t":0.55,"v":1},{"t":0.2,"v":1,"from":"end"},{"t":0,"v":0,"from":"end"}]}},"mask":{"shape":{"type":"rect","w":520,"h":640},"transform":{"y":{"keys":[{"t":0.5,"v":0},{"t":0.95,"v":-310}]}}},"children":[{"kind":"shape","shape":{"type":"ellipse","w":250,"h":250},"fill":{"gradient":"linear","angle":60,"stops":[[0,"#FFE9A8"],[0.5,"#F2B03A"],[1,"#B8751A"]]},"effects":{"shadow":{"color":"rgba(0,0,0,0.5)","blur":40,"y":16}}},{"kind":"shape","shape":{"type":"ellipse","w":206,"h":206},"stroke":{"color":"rgba(120,70,10,0.55)","width":6}},{"kind":"text","text":"$","font":{"family":"Inter ExtraBold","size":150},"fill":"#8A5512","align":"center","valign":"middle"}]},
{"kind":"shape","shape":{"type":"rect","w":430,"h":60,"radius":30},"fill":{"gradient":"linear","angle":90,"stops":[[0,"#2A2E3A"],[1,"#12141B"]]},"stroke":{"color":"rgba(255,255,255,0.25)","width":3},"transform":{"x":430,"y":590,"opacity":{"keys":[{"t":0.1,"v":0},{"t":0.3,"v":1},{"t":0.2,"v":1,"from":"end"},{"t":0,"v":0,"from":"end"}]}}},
{"kind":"text","text":"$20B","font":{"family":"Inter ExtraBold","size":220,"tracking":-8,"tabular":true},"count":{"from":0,"to":20,"decimals":0,"prefix":"$","suffix":"B","progress":{"keys":[{"t":0.95,"v":0,"ease":"out-quart"},{"t":1.8,"v":1}]}},"fill":"#FFFFFF","align":"center","valign":"middle","transform":{"x":430,"y":{"keys":[{"t":0.95,"v":800,"ease":"out-quart"},{"t":1.5,"v":770}]},"opacity":{"keys":[{"t":0.95,"v":0},{"t":1.1,"v":1},{"t":0.2,"v":1,"from":"end"},{"t":0,"v":0,"from":"end"}]}}}]`

const ReplySchema = z.object({ idea: z.string().optional(), layers: z.array(z.unknown()).min(1).max(120) })

/** Every layer that can be drawn, its children too; null when too little of it can. */
export function readGraphic(content: { type: string; name?: string; input?: unknown }[]): LayerInput[] | null {
  const call = content.find((b) => b.type === 'tool_use' && b.name === GRAPHIC_TOOL)
  const reply = ReplySchema.safeParse(call?.input)
  if (!reply.success) return null
  let lost = 0
  let kept = 0
  const read = (raw: unknown): LayerInput | null => {
    const o = raw as { kind?: string; children?: unknown[] }
    if (!o || typeof o !== 'object') return null
    // Nothing of the person's own files, and nothing this computer would have to fetch.
    const { asset: _asset, file: _file, ...safe } = o as Record<string, unknown>
    const given = o.kind === 'group' && Array.isArray(o.children) ? { ...safe, children: o.children.map(read).filter((c): c is LayerInput => c !== null) } : safe
    const parsed = LayerInputSchema.safeParse(given)
    if (parsed.success) kept++
    else lost++
    return parsed.success ? parsed.data : null
  }
  const layers = reply.data.layers.map(read).filter((l): l is LayerInput => l !== null)
  return layers.length > 0 && lost <= kept * 0.25 ? layers : null
}

/** The frame's free part for a room, in pixels. */
function roomBox(room: DesignOp['room'], W: number, H: number): string {
  const box = { left: [0, 0, 0.5, 1], right: [0.5, 0, 0.5, 1], foot: [0, 0.6, 1, 0.4], full: [0, 0, 1, 1], over: [0, 0, 1, 1] }[room]
  return `x ${Math.round(box[0] * W)} to ${Math.round((box[0] + box[2]) * W)}, y ${Math.round(box[1] * H)} to ${Math.round((box[1] + box[3]) * H)}`
}

const ROOM: Record<DesignOp['room'], string> = {
  left: 'the left half is yours; the speaker stands in the right half (the shot is reframed for it). Put a side wash of your own under it',
  right: 'the right half is yours; the speaker stands in the left half (the shot is reframed for it). Put a side wash of your own under it',
  foot: 'the foot of the frame is yours, under the speaker; darken it yourself with a gradient that is clear by 45% of the height',
  full: 'the whole frame is yours, on a ground of your own, opaque from edge to edge; the speaker is heard, not seen',
  over: 'over the picture: only small things in the clear parts of it, the face left alone'
}

export interface DesignBrief {
  /** What the designer is told. */
  text: string
  /** A moment to show them the shot at, in the edit's seconds, and the cut as it is framed for it. */
  at: number
  cut: Cut
  /** The frame it is drawn on, in pixels. */
  size: { width: number; height: number }
}

/** What a designer is told about the moment a design goes on; null when it is nowhere in the cut. */
export function designBrief(doc: EditDoc, cut: Cut, op: DesignOp, others: string[]): DesignBrief | null {
  // Put on as an empty graphic to find out when it is up, and to make its room as it will be made.
  const context = { words: doc.words, sources: doc.sources, assets: doc.assets }
  const marker = { op: 'motion-add', kind: 'layers', from: op.from, to: op.to, place: op.room, text: [], items: [], values: [], box: [], icon: '', style: '', color: '', fx: [], layers: [{ kind: 'shape', shape: { type: 'rect', w: 2, h: 2 }, fill: '#000000' }] }
  let r = applyOps(cut, [marker], context)
  if (r.applied.length === 0) return null
  let resolved = resolveCut(r.cut, doc.words, doc.sources)
  let scene = sceneForCut({ cut: r.cut, resolved, words: doc.words, sources: doc.sources, brand: null })
  const item = scene.items.find((i) => i.id === r.cut.motion?.[r.cut.motion.length - 1]?.id)
  if (!item) return null
  if (op.room === 'left' || op.room === 'right')
    for (const room of roomOps(r.cut, resolved, doc.sources, item, op.room, scene.size.width / Math.max(1, scene.size.height))) r = applyOps(r.cut, [room], context)
  resolved = resolveCut(r.cut, doc.words, doc.sources)
  scene = sceneForCut({ cut: r.cut, resolved, words: doc.words, sources: doc.sources, brand: null })
  const { width: W, height: H } = scene.size
  const d: Direction = cut.direction ?? {}
  const theme = directed(themeFrom(null), d)
  const said = resolved.words
    .filter((w) => w.outEnd > item.start - 0.2 && w.outStart < item.end)
    .slice(0, 60)
    .map((w) => `${w.text} (${Math.max(0, w.outStart - item.start).toFixed(2)})`)
    .join(' ')
  const text = [
    `The frame is ${W} by ${H}. It is up for ${(item.end - item.start).toFixed(2)} seconds.`,
    `Its room: ${ROOM[op.room]} (${roomBox(op.room, W, H)}).`,
    `What it has to make clear, and the idea so far: ${op.brief}`,
    `Said while it is up, each word with the second it starts: ${said}`,
    `The video's art direction: ${d.idea ? `${d.idea}. ` : ''}Accent ${theme.accent}, second ${theme.second}, display face ${theme.display}, body face ${theme.body}, hand ${theme.script}, ${theme.ground} grounds. Stay in it.`,
    others.length ? `Already in this video, so do something else: ${others.join('; ')}.` : '',
    'The shot it goes on follows.'
  ]
    .filter(Boolean)
    .join('\n')
  // The marker comes off again: only the room it made is seen.
  const bare: Cut = { ...r.cut, motion: (r.cut.motion ?? []).filter((m) => m.id !== item.id) }
  return { text, at: item.start + (item.end - item.start) * 0.5, cut: bare, size: { width: W, height: H } }
}

/** A design as the edit takes it; null until it has been made. */
export function designedOp(op: DesignOp): unknown {
  if (!op.layers?.length) return null
  const { from, to, room, layers } = op
  return { op: 'motion-add', kind: 'layers', from, to, place: room, text: [], items: [], values: [], box: [], icon: '', style: '', color: '', fx: [], layers }
}

/** What else is in a plan, for a designer to do differently. */
export const otherGraphics = (ops: PlannerOp[], but: unknown): string[] =>
  ops.flatMap((o) => {
    if (o === but) return []
    if (o.op === 'motion-add') return [`${o.kind}${o.style ? ` ${o.style}` : ''}`]
    return isDesign(o) ? [(o as unknown as DesignOp).brief.slice(0, 90)] : []
  })

/** Where the design's own cut is read from: the edit as the ops before it leave it. */
export function cutBefore(doc: EditDoc, made: { op: unknown; from: number }[], index: number): Cut {
  const context = { words: doc.words, sources: doc.sources, assets: doc.assets }
  return applyOps(currentCut(doc), made.filter((m) => m.from !== index).map((m) => m.op), context).cut
}
