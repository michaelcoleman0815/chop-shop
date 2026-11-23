import { isKeyed, type Anim } from '../anim'
import { tracksOf } from '../tracks/resolve'
import { CAMERA_KEYED, LIGHT_KEYED, MAX_LIGHTS, MAX_OBJECTS, OBJECT_KEYED, Scene3DSchema, type Scene3D } from './spec'

/**
 * 3D clips as the planner writes and reads them. A 3D clip is an ordinary
 * clip on a picture track (shared/tracks/planner): `clip-add` with kind "3d"
 * carries its scene in `spec`, and `clip-update` changes it, objects and
 * lights by id. This adds what the planner needs besides: the family guide,
 * sent with a request only when it speaks of 3D or the cut already has a 3D
 * clip (main/planner-guides), the scene written out for <tracks>, and the
 * check a new scene gets before it is applied.
 */

/** Words that ask for 3D: a person's, not the app's. */
const ASKS_FOR_3D =
  /\b3-?d\b|\bthree[- ]?d\b|\bextru(de|ded|sion)\b|\b(rotat|turn|spin)\w*(\s+\w+){0,3}\s+in space\b|\borbit\w*\b|\bcamera (fl(y|ies|ying|ew)|move|moves|pushe?s? in|dolly|trucks?)\b|\bfly (in|through|around|the camera)\b|\bfly-?through\b|\bmodels?\b|\bgltf\b|\bglb\b/i

/** Whether this ask or this cut needs the 3D guide. */
export function wants3D(ask: string, cut: { tracks?: { clips: { kind: string }[] }[] }): boolean {
  return ASKS_FOR_3D.test(ask) || tracksOf(cut as never).some((t) => t.clips.some((c) => c.kind === '3d'))
}

/** The line the planner always has: what 3D does and the ops that make it. */
export const THREE_D_INDEX =
  '3D: real 3D clips on a picture track (cards showing material or words, extruded titles, boxes, spheres and other shapes, glTF models, lights, a camera that moves, orbits and zooms, all keyable): clip-add with kind "3d" and its scene in spec; clip-update changes the scene by object id.'

const q = (json: unknown): string => JSON.stringify(JSON.stringify(json))
const keys = (...pairs: [number, number, string?][]): { keys: { t: number; v: number; ease?: string }[] } => ({
  keys: pairs.map(([t, v, ease]) => (ease ? { t, v, ease } : { t, v }))
})
const add = (from: string, to: string, scene: unknown): string =>
  `{"op":"clip-add","kind":"3d","track":"","src":"","text":"","color":"","from":"${from}","to":"${to}","in":0,"speed":0,"fit":"","blend":"","opacity":0,"volume":0,"spec":${q({ scene })}}`
const update = (clip: string, scene: unknown): string => `{"op":"clip-update","clip":"${clip}","track":"","from":"","to":"","spec":${q({ scene })}}`

/** The full guide, sent when the ask or the cut needs it. */
export function threeDGuide(): string {
  return `## 3D clips
A 3D clip is a scene drawn in real 3D (three.js) on a picture track, over the edit and under the captions, the same in the editor and the export. It is a clip like any other: it starts and ends on anchors, and its own opacity and blend apply to the whole picture. Its scene goes in "spec" as {"scene":{"objects":[...],"lights":[...],"camera":{...}}}.
Space is in pixels of the full-size frame, from its centre: x right, y up, z toward the camera. The camera's home looks square at the middle from just far enough back that the plane z 0 fills the frame one to one: a card as wide as the frame at z 0 fills it, and z -2000 is far behind it.
Objects (at most ${MAX_OBJECTS}), each with an "id" (o1, o2 ...) and a "type":
- card: a flat picture with rounded corners: "src" material by id (a picture or a video, which plays from "in" seconds), or "title" words set flat on it; "w" and "h" (most of the frame's short side wide, as tall as its picture is, when left out), "depth" for a thick card, "color" its back and its words' ground.
- text: an extruded title: "text" (a new line is \\n), "size" in pixels, "depth", "font" (a bundled face, Inter ExtraBold when left out), "color", "metal" and "rough" 0 to 1.
- box ("w","h","d"), sphere ("radius"), plane ("w","h"), cylinder ("radius","h"), torus ("radius","tube"), each with "color", "metal", "rough".
- model: a glTF or GLB file on this computer, by its path in "src" (one the person names), scaled so its longest side is "size".
Each object's ${OBJECT_KEYED.join(', ')} take a number or keys: {"keys":[{"t":0,"v":0},{"t":1,"v":360,"ease":"ease-out"}]}, t in seconds from the clip's start. x, y, z place its middle; rx, ry, rz turn it in degrees (ry spins it about the vertical); scale 1 is its own size.
Camera, all keyable: ${CAMERA_KEYED.join(', ')}. x and y move it across and up; z moves it back from home (negative moves in); tx, ty, tz are what it looks at (the middle when left out); orbit turns it round what it looks at, in degrees (90 sees the scene from its right); fov is its lens in degrees (40 at home; less zooms in). To slide the view, key x and tx together.
Lights (at most ${MAX_LIGHTS}), each with "id" (l1 ...), "type" ambient, directional, point or spot, "color", and ${LIGHT_KEYED.join(', ')} keyable: intensity 1 lights a surface facing it fully; x, y, z place it (a directional light shines from there toward the middle); a spot aims at tx, ty, tz with "angle" in degrees. A scene with no lights has a soft fill and a key light from above right.
- ${add('w3', '4s', { objects: [{ id: 'o1', type: 'text', text: 'LAUNCH DAY', size: 180, z: keys([0, -4000], [1.2, 0, 'easy-ease-out']), ry: keys([0, -70], [1.2, 0, 'easy-ease-out']), opacity: keys([0, 0], [0.4, 1]) }] })}: makes the title fly in in 3D: an extruded title comes in from far behind the frame, turning to face the camera, and lands as w3 is said.
- ${add('w12', 'w20.end', { objects: [{ id: 'o1', type: 'card', src: 'a2', depth: 12, ry: keys([0, 0], [3, 360, 'ease-in-out']) }] })}: spins the product card: material a2 on a card that turns a full circle about the vertical over 3 s.
- ${update('c2', { objects: [{ id: 'o1', ry: keys([0, 0], [2, 360]) }, { id: 'o2', remove: true }] })}: changes the scene of 3D clip c2: its object o1 now spins, and o2 is taken away. Only what is named changes; an object with a new id is added and needs its type.
- ${update('c2', { camera: { z: keys([0, 1500], [4, 0, 'ease-out']), orbit: keys([0, -25], [4, 25, 'ease-in-out']) } })}: a camera fly-in: it comes from 1500 px back to home while orbiting 50 degrees round the scene.
- ${update('c2', { objects: [{ id: 'o3', type: 'model', src: '/Users/you/Desktop/shoe.glb', size: 700, ry: keys([0, 0], [6, 180]) }], lights: [{ id: 'l1', type: 'spot', y: 900, z: 900, intensity: 1.4, angle: 30 }] })}: adds a model that turns slowly, under a spot from above.
What it is not: there is no modelling, no physics, no shadows and no depth of field. Shapes are posed by keys, not simulated; anything more needs a model made elsewhere. The phone's export does not draw 3D clips yet.`
}

/** The family guide's entry (main/planner-guides). */
export const THREE_D_GUIDE = {
  name: '3d',
  index: THREE_D_INDEX,
  wanted: (ask: string, cut: { tracks?: { clips: { kind: string }[] }[] }): boolean => wants3D(ask, cut),
  guide: threeDGuide
}

function value(name: string, a: Anim<number> | undefined): string | null {
  if (a === undefined) return null
  if (isKeyed(a)) return `${name} keys ${a.keys.map((k) => `${k.t}:${k.v}`).join(' ')}`
  return `${name} ${Math.round(a * 1000) / 1000}`
}

/** A 3D clip's scene in a line for <tracks>: the camera's settings, then each object and light with its own. */
export function sceneLine(scene: Scene3D): string {
  const parts: string[] = []
  const cam = CAMERA_KEYED.map((k) => value(k, scene.camera[k])).filter(Boolean)
  parts.push(`camera ${cam.length ? cam.join(', ') : 'at home'}`)
  for (const o of scene.objects) {
    const what = [
      o.src ? `src ${o.src}` : null,
      o.text ? `"${o.text.slice(0, 40)}"` : null,
      o.title ? `title "${o.title.slice(0, 40)}"` : null,
      o.color ?? null,
      ...OBJECT_KEYED.map((k) => value(k, o[k]))
    ].filter(Boolean)
    parts.push(`${o.id} ${o.type}${what.length ? ` ${what.join(', ')}` : ''}`)
  }
  for (const l of scene.lights) {
    const what = LIGHT_KEYED.map((k) => value(k, l[k])).filter(Boolean)
    parts.push(`${l.id} ${l.type} light${what.length ? ` ${what.join(', ')}` : ''}`)
  }
  return parts.join('; ')
}

/** Why a new 3D clip's scene cannot be made, or null when it can. */
export function sceneRefusal(scene: unknown): string | null {
  if (scene === undefined) return 'A 3D clip needs its scene in spec: {"scene":{"objects":[...]}}.'
  const r = Scene3DSchema.safeParse(scene)
  if (r.success) return null
  const issue = r.error.issues[0]
  return `Its scene does not fit: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim()
}
