import { readFileSync } from 'fs'
import { join } from 'path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { parseFont, layoutGlyphs } from './glyphs'
import { cameraPose, cardSize, objectPose, Scene3DView, titleShapes, titleSize, TITLE_3D_FACE } from './scene3d'
import { homeDistance, mergeScene, Scene3DSchema, shiftSceneKeys } from './spec'
import { num } from '../anim'

/**
 * The 3D scene builder in Node, where there is no WebGL: the object graph a
 * spec makes, the camera and objects where their keys put them, and the
 * bundled faces read into outlines an extruded title is made of.
 */

const FONTS = join(__dirname, '../../../resources/fonts')
const inter = parseFont(readFileSync(join(FONTS, 'Inter-ExtraBold.ttf')))
const vertical = { width: 1080, height: 1920 }

describe('the bundled faces as outlines', () => {
  it('reads every Latin letter of Inter, accented ones made of parts too', () => {
    expect(inter.unitsPerEm).toBe(2048)
    for (const ch of 'AZaz09?&é') {
      const g = inter.glyph(ch)
      expect(g, ch).not.toBeNull()
      expect(g!.path.length, ch).toBeGreaterThan(2)
      expect('m' in g!.path[0], ch).toBe(true)
    }
    // An O is two contours, the outside and the hole.
    expect(inter.glyph('O')!.path.filter((c) => 'm' in c)).toHaveLength(2)
    // A space has width and nothing to draw.
    expect(inter.glyph(' ')!.path).toEqual([])
    expect(inter.glyph(' ')!.advance).toBeGreaterThan(0)
  })

  it('reads every face the app bundles', () => {
    for (const file of ['Anton-Regular.ttf', 'ArchivoBlack-Regular.ttf', 'Sora.ttf', 'Cinzel.ttf', 'BebasNeue-Regular.ttf', 'DMSerifDisplay-Regular.ttf']) {
      const f = parseFont(readFileSync(join(FONTS, file)))
      expect(f.glyph('A')!.path.length, file).toBeGreaterThan(2)
    }
  })

  it('centres a line on the origin and stacks lines a line apart', () => {
    const one = layoutGlyphs(inter, 'HI')
    const right = one[1].x + one[1].glyph.advance
    expect(one[0].x).toBeCloseTo(-right, 6)
    const two = layoutGlyphs(inter, 'A\nB')
    expect(two[0].y).toBeGreaterThan(two[1].y)
  })

  it('makes letters into shapes with their holes, as big as asked', () => {
    const shapes = titleShapes(inter, 'O', 200)
    expect(shapes).toHaveLength(1)
    expect(shapes[0].holes).toHaveLength(1)
    const box = new THREE.Box2().setFromPoints(shapes[0].getPoints())
    // A capital O at 200 px is about three quarters of that tall.
    expect(box.max.y - box.min.y).toBeGreaterThan(130)
    expect(box.max.y - box.min.y).toBeLessThan(170)
    // Centred on its capitals.
    expect(Math.abs(box.max.y + box.min.y) / 2).toBeLessThan(12)
  })
})

describe('a scene as three.js objects', () => {
  const spec = Scene3DSchema.parse({
    objects: [
      { id: 'o1', type: 'card', src: '/pics/phone.jpg', ry: { keys: [{ t: 0, v: 0 }, { t: 2, v: 360 }] } },
      { id: 'o2', type: 'text', text: 'LAUNCH', z: { keys: [{ t: 0, v: -3000 }, { t: 1, v: 0, ease: 'ease-out' }] } },
      { id: 'o3', type: 'box', w: 200, color: '#FF0000', x: 300 },
      { id: 'o4', type: 'torus', opacity: 0.5 }
    ],
    lights: [{ id: 'l1', type: 'spot', x: 0, y: 800, z: 1200, intensity: 2, angle: 25 }],
    camera: { z: { keys: [{ t: 0, v: 2000 }, { t: 2, v: 0 }] }, orbit: { keys: [{ t: 0, v: -30 }, { t: 2, v: 30 }] } }
  })

  it('builds each object once, by id, with its shape and look', () => {
    const view = new Scene3DView(vertical, { font: (family) => (family === TITLE_3D_FACE ? inter : null) })
    view.set(spec)
    const names = view.scene.children.map((c) => c.name)
    expect(names).toEqual(expect.arrayContaining(['o1', 'o2', 'o3', 'o4', 'l1']))
    // The card: its back, and a front waiting for its picture.
    const card = view.object('o1')!
    expect(card.children).toHaveLength(2)
    const face = (card.children[1] as THREE.Mesh).material as THREE.MeshBasicMaterial
    expect(face.map).toBeInstanceOf(THREE.Texture)
    expect(face.visible).toBe(false)
    // The title, extruded from Inter's outlines, about as deep as a third of its size.
    const title = (view.object('o2')!.children[0] as THREE.Mesh).geometry
    expect(title).toBeInstanceOf(THREE.ExtrudeGeometry)
    title.computeBoundingBox()
    const depth = title.boundingBox!.max.z - title.boundingBox!.min.z
    expect(depth).toBeGreaterThan(40)
    expect(depth).toBeLessThan(70)
    const box = view.object('o3')!.children[0] as THREE.Mesh
    expect(box.geometry).toBeInstanceOf(THREE.BoxGeometry)
    expect((box.material as THREE.MeshStandardMaterial).color.getHexString()).toBe('ff0000')
    const spot = view.scene.getObjectByName('l1') as THREE.SpotLight
    expect(spot).toBeInstanceOf(THREE.SpotLight)
    expect(spot.angle).toBeCloseTo((25 * Math.PI) / 180, 6)

    // The same spec again builds nothing new; a changed size builds that one object again.
    const before = view.object('o3')
    view.set(spec)
    expect(view.object('o3')).toBe(before)
    view.set({ ...spec, objects: spec.objects.map((o) => (o.id === 'o3' ? { ...o, w: 400 } : o)) })
    expect(view.object('o3')).not.toBe(before)
    expect(view.object('o1')).toBe(card)
    // A moved object is not built again: keys are posed, not built.
    view.set({ ...spec, objects: spec.objects.map((o) => (o.id === 'o1' ? { ...o, x: 50 } : o)) })
    expect(view.object('o1')).toBe(card)
    // Gone from the spec, gone from the scene.
    view.set({ ...spec, objects: spec.objects.filter((o) => o.id !== 'o4') })
    expect(view.scene.getObjectByName('o4')).toBeUndefined()
    view.dispose()
  })

  it('leaves a title out until its face is in, then builds it', () => {
    let ready = false
    const view = new Scene3DView(vertical, { font: () => (ready ? inter : null) })
    view.set(spec)
    expect(view.object('o2')!.children).toHaveLength(0)
    ready = true
    view.set(spec)
    expect(view.object('o2')!.children).toHaveLength(1)
  })

  it('shows a card’s picture once it is in, at the picture’s shape', () => {
    let pic: { image: TexImageSource; width: number; height: number; stamp: number } | null = null
    const view = new Scene3DView(vertical, { picture: () => pic })
    view.set(spec)
    const face = (): THREE.MeshBasicMaterial => (view.object('o1')!.children[1] as THREE.Mesh).material as THREE.MeshBasicMaterial
    view.pose(0, 2)
    expect(face().visible).toBe(false)
    pic = { image: {} as TexImageSource, width: 400, height: 400, stamp: 1 }
    view.set(spec)
    view.pose(0, 2)
    expect(face().visible).toBe(true)
    expect(face().map!.image).toBe(pic.image)
    const geo = (view.object('o1')!.children[1] as THREE.Mesh).geometry
    geo.computeBoundingBox()
    const b = geo.boundingBox!
    // A square picture makes a square card, 80% of the frame's short side.
    expect(b.max.x - b.min.x).toBeCloseTo(864, 0)
    expect(b.max.y - b.min.y).toBeCloseTo(864, 0)
    expect(cardSize({ id: 'c', type: 'card' }, vertical, null)).toEqual({ w: 864, h: 486 })
  })

  it('poses the objects and the camera where their keys say', () => {
    const view = new Scene3DView(vertical, { font: () => inter })
    view.set(spec)
    view.pose(1, 2)
    const home = homeDistance(vertical)
    // Halfway along its keys the card has turned 180 degrees.
    expect(view.object('o1')!.rotation.y).toBeCloseTo(Math.PI, 6)
    // The title has flown all the way in by its second key.
    expect(view.object('o2')!.position.z).toBeCloseTo(0, 6)
    expect(view.object('o3')!.position.x).toBe(300)
    // The camera, halfway in and square on: orbit -30 to 30 is 0 at the middle.
    expect(view.camera.position.x).toBeCloseTo(0, 6)
    expect(view.camera.position.z).toBeCloseTo(home + 1000, 4)
    const ahead = new THREE.Vector3()
    view.camera.getWorldDirection(ahead)
    expect(ahead.z).toBeCloseTo(-1, 6)
    // Half seen.
    const torus = view.object('o4')!.children[0] as THREE.Mesh
    expect((torus.material as THREE.Material).opacity).toBeCloseTo(0.5, 6)
    expect((torus.material as THREE.Material).transparent).toBe(true)

    view.pose(0, 2)
    // At the start, 30 degrees round to the left, still looking at the middle.
    const p = view.camera.position
    expect(Math.atan2(p.x, p.z) * (180 / Math.PI)).toBeCloseTo(-30, 4)
    expect(Math.hypot(p.x, p.z)).toBeCloseTo(home + 2000, 3)
    view.camera.getWorldDirection(ahead)
    expect(ahead.x).toBeCloseTo(Math.sin((30 * Math.PI) / 180), 4)
    expect(view.object('o2')!.position.z).toBe(-3000)
  })

  it('reckons the camera’s home so the frame’s plane fills the picture one to one', () => {
    const at = cameraPose({}, vertical, 0, 1)
    expect(at.position).toEqual([0, 0, homeDistance(vertical)])
    expect(at.fov).toBe(40)
    // At home, the plane z = 0 is exactly the frame's height tall in view.
    const seen = 2 * at.position[2] * Math.tan(((at.fov / 2) * Math.PI) / 180)
    expect(seen).toBeCloseTo(1920, 6)
    expect(objectPose({ id: 'o', type: 'box' }, 0, 1)).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0], scale: 1, opacity: 1 })
  })

  it('sets a title with no size as big as fits the frame, and one with a size at it', () => {
    const short = titleSize({ id: 't', type: 'text', text: 'GO' }, vertical, inter)
    expect(short).toBe(162)
    const long = titleSize({ id: 't', type: 'text', text: 'LAUNCH DAY IS HERE' }, vertical, inter)
    expect(long).toBeLessThan(short)
    const width = titleShapes(inter, 'LAUNCH DAY IS HERE', long).reduce((box, sh) => box.union(new THREE.Box2().setFromPoints(sh.getPoints())), new THREE.Box2())
    expect(width.max.x - width.min.x).toBeLessThanOrEqual(1080 * 0.86)
    expect(width.max.x - width.min.x).toBeGreaterThan(1080 * 0.75)
    expect(titleSize({ id: 't', type: 'text', text: 'LAUNCH DAY IS HERE', size: 300 }, vertical, inter)).toBe(300)
  })

  it('lights a scene that names no lights', () => {
    const view = new Scene3DView(vertical)
    view.set(Scene3DSchema.parse({ objects: [{ id: 'o1', type: 'sphere' }] }))
    view.pose(0, 1)
    const lights = view.scene.children.filter((c) => (c as THREE.Light).isLight)
    expect(lights.map((l) => l.type).sort()).toEqual(['AmbientLight', 'DirectionalLight', 'DirectionalLight'])
  })
})

describe('changing a scene', () => {
  const was = Scene3DSchema.parse({
    objects: [
      { id: 'o1', type: 'card', src: 'a1' },
      { id: 'o2', type: 'box' }
    ],
    camera: { fov: 30 }
  })

  it('merges objects by id, adds new ones, takes away the ones it is told to', () => {
    const r = mergeScene(was, {
      objects: [{ id: 'o1', ry: { keys: [{ t: 0, v: 0 }, { t: 3, v: 360 }] } }, { id: 'o2', remove: true }, { id: 'o3', type: 'sphere', radius: 90 }],
      camera: { z: 500 }
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scene.objects.map((o) => o.id)).toEqual(['o1', 'o3'])
    expect(r.scene.objects[0]).toMatchObject({ type: 'card', src: 'a1', ry: { keys: [{ t: 0, v: 0 }, { t: 3, v: 360 }] } })
    expect(r.scene.camera).toEqual({ fov: 30, z: 500 })
  })

  it('says why a change cannot be made', () => {
    expect(mergeScene(was, { objects: [{ id: 'o9', x: 4 }] })).toEqual({ ok: false, reason: 'o9 is new to the scene, so it needs its type.' })
    expect(mergeScene(was, { objects: [{ id: 'o9', remove: true }] })).toEqual({ ok: false, reason: 'There is no object o9 in the scene to take away.' })
  })

  it('moves keys for the second half of a split', () => {
    const s = Scene3DSchema.parse({ objects: [{ id: 'o1', type: 'box', ry: { keys: [{ t: 0, v: 0 }, { t: 4, v: 360 }] } }] })
    const tail = shiftSceneKeys(s, 1, (a) => num(a, 1, 4))
    expect(tail.objects[0].ry).toEqual({ keys: [{ t: 0, v: 90 }, { t: 3, v: 360 }] })
  })
})
