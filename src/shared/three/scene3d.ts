import * as THREE from 'three'
import { num } from '../anim'
import type { Size } from '../motion/types'
import { layoutGlyphs, type GlyphFont } from './glyphs'
import { HOME_FOV, homeDistance, TITLE_3D_FACE, type Camera3D, type Light3D, type Object3D, type Scene3D } from './spec'

export { TITLE_3D_FACE }

/**
 * A 3D clip's scene built as three.js objects, the one builder the editor's
 * preview and the export's 3D page both use, so the two draw the same scene
 * from the same numbers. `set` brings the object graph in line with the spec
 * (building an object again only when its shape or look changes), `pose`
 * puts every object, light and the camera where its keys say for a moment of
 * the clip, and `renderScene3D` draws it with a WebGL renderer the caller
 * keeps. What it shows comes from `Scene3DSources`: the bundled faces'
 * outlines, a card's picture or the frame of its video, a model's graph.
 * Each place supplies its own; without one, that part waits (a card shows its
 * colour, a title or a model is left out) and the rest still builds, which is
 * how the tests build scenes in Node.
 */

/** A picture for a card: anything WebGL can upload, at its size. */
export interface Picture {
  image: TexImageSource
  width: number
  height: number
  /** Changes when its pixels do: a video's next frame. */
  stamp: number | string
}

export interface Scene3DSources {
  /** A bundled face's outlines by family name; null while it loads or when there is none. */
  font?(family: string): GlyphFont | null
  /** What a card with a `src` shows `local` seconds into the clip: its picture, or its video's frame there. */
  picture?(obj: Object3D, local: number): Picture | null
  /** A card's words drawn flat on its colour, w by h pixels; null where there is nothing to draw on. */
  words?(obj: Object3D, w: number, h: number): Picture | null
  /** A model's graph once it has loaded, shared: the scene builds its own copy of it. */
  model?(src: string): THREE.Object3D | null
}

const rad = (deg: number): number => (deg * Math.PI) / 180
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

export interface Pose {
  position: [number, number, number]
  /** Radians about x, y and z, in that order. */
  rotation: [number, number, number]
  scale: number
  opacity: number
}

/** Where an object is and how it turns, `local` seconds into a clip `length` long. */
export function objectPose(o: Object3D, local: number, length: number): Pose {
  return {
    position: [num(o.x, local, length, 0), num(o.y, local, length, 0), num(o.z, local, length, 0)],
    rotation: [rad(num(o.rx, local, length, 0)), rad(num(o.ry, local, length, 0)), rad(num(o.rz, local, length, 0))],
    scale: num(o.scale, local, length, 1),
    opacity: clamp01(num(o.opacity, local, length, 1))
  }
}

export interface CameraPose {
  position: [number, number, number]
  target: [number, number, number]
  /** Degrees of the frame's height. */
  fov: number
}

/** Where the camera stands, what it looks at and its lens, at a moment. */
export function cameraPose(cam: Camera3D, design: Size, local: number, length: number): CameraPose {
  const home = homeDistance(design)
  const target: [number, number, number] = [num(cam.tx, local, length, 0), num(cam.ty, local, length, 0), num(cam.tz, local, length, 0)]
  const x = num(cam.x, local, length, 0)
  const y = num(cam.y, local, length, 0)
  const z = home + num(cam.z, local, length, 0)
  // Around what it looks at, about the vertical: 90 stands it on the scene's right.
  const a = rad(num(cam.orbit, local, length, 0))
  const dx = x - target[0]
  const dz = z - target[2]
  const position: [number, number, number] = [target[0] + dx * Math.cos(a) + dz * Math.sin(a), y, target[2] - dx * Math.sin(a) + dz * Math.cos(a)]
  const fov = Math.min(150, Math.max(5, num(cam.fov, local, length, HOME_FOV)))
  return { position, target, fov }
}

/** Light levels as people say them, 1 lighting a surface that faces it fully: three's physical units are π times that. */
const LEVEL = Math.PI

/** The lights a scene that names none is lit by: a soft fill all round and a key from above, right and in front. */
export function defaultLights(design: Size): Light3D[] {
  const home = homeDistance(design)
  return [
    { id: 'fill', type: 'ambient', intensity: 0.55 },
    { id: 'key', type: 'directional', intensity: 0.85, x: design.width * 0.6, y: design.height * 0.9, z: home },
    { id: 'rim', type: 'directional', intensity: 0.25, x: -design.width, y: -design.height * 0.2, z: home * 0.4 }
  ]
}

interface Built {
  /** What its geometry and look were built from: built again when this changes. */
  key: string
  root: THREE.Object3D
  /** Every material it draws with, and the opacity each has of its own, which a fade multiplies. */
  materials: { m: THREE.Material; opacity: number; transparent: boolean }[]
  /** A card's picture, kept fresh as its video plays. */
  texture?: { tex: THREE.Texture; face: THREE.MeshBasicMaterial; stamp: number | string | null; from: 'picture' | 'words' }
}

interface BuiltLight {
  key: string
  light: THREE.Light
}

const DEFAULT_COLOR = '#D9D9D9'

function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape()
  const x = -w / 2
  const y = -h / 2
  const k = Math.max(0, Math.min(r, w / 2, h / 2))
  s.moveTo(x + k, y)
  s.lineTo(x + w - k, y)
  if (k) s.quadraticCurveTo(x + w, y, x + w, y + k)
  s.lineTo(x + w, y + h - k)
  if (k) s.quadraticCurveTo(x + w, y + h, x + w - k, y + h)
  s.lineTo(x + k, y + h)
  if (k) s.quadraticCurveTo(x, y + h, x, y + h - k)
  s.lineTo(x, y + k)
  if (k) s.quadraticCurveTo(x, y, x + k, y)
  return s
}

/** A flat shape whose texture spans its box, 0 to 1 either way. */
function faceGeometry(shape: THREE.Shape, w: number, h: number): THREE.ShapeGeometry {
  const g = new THREE.ShapeGeometry(shape, 8)
  const pos = g.getAttribute('position')
  const uv = g.getAttribute('uv')
  for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + w / 2) / w, (pos.getY(i) + h / 2) / h)
  uv.needsUpdate = true
  return g
}

function standard(o: Object3D, fallback = DEFAULT_COLOR, metal = 0, rough = 0.5): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(o.color ?? fallback),
    metalness: o.metal ?? metal,
    roughness: o.rough ?? rough
  })
}

/** The outlines of a title's letters as shapes, in design pixels, centred on the origin. */
export function titleShapes(font: GlyphFont, text: string, size: number): THREE.Shape[] {
  const k = size / font.unitsPerEm
  const shapes: THREE.Shape[] = []
  for (const g of layoutGlyphs(font, text)) {
    if (g.glyph.path.length === 0) continue
    const path = new THREE.ShapePath()
    const X = (x: number): number => (g.x + x) * k
    const Y = (y: number): number => (g.y + y) * k
    for (const c of g.glyph.path) {
      if ('m' in c) path.moveTo(X(c.m[0]), Y(c.m[1]))
      else if ('l' in c) path.lineTo(X(c.l[0]), Y(c.l[1]))
      else path.quadraticCurveTo(X(c.q[0]), Y(c.q[1]), X(c.q[2]), Y(c.q[3]))
    }
    shapes.push(...path.toShapes())
  }
  return shapes
}

/** The size a card is when it names none: most of the frame's short side wide, as tall as its picture is. */
export function cardSize(o: Object3D, design: Size, aspect: number | null): { w: number; h: number } {
  const ratio = aspect && aspect > 0 ? aspect : 16 / 9
  const w = o.w ?? (o.h ? o.h * ratio : Math.min(design.width, design.height) * 0.8)
  const h = o.h ?? w / ratio
  return { w, h }
}

/**
 * A title's size when it names none, in design pixels: 15% of the frame's
 * short side, smaller when its longest line would run wider than 86% of the
 * frame (as a flat title wraps there).
 */
export function titleSize(o: Object3D, design: Size, font?: GlyphFont | null): number {
  if (o.size) return o.size
  const usual = Math.round(Math.min(design.width, design.height) * 0.15)
  if (!font || !o.text) return usual
  const advance = (ch: string): number => (font.glyph(ch) ?? font.glyph('?'))?.advance ?? 0
  const widest = Math.max(1, ...o.text.split('\n').map((line) => Array.from(line).reduce((w, ch) => w + advance(ch), 0)))
  return Math.min(usual, Math.floor((design.width * 0.86 * font.unitsPerEm) / widest))
}

export class Scene3DView {
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(HOME_FOV, 16 / 9, 1, 100_000)
  private spec: Scene3D = { objects: [], lights: [], camera: {} }
  private objects = new Map<string, Built>()
  private lights = new Map<string, BuiltLight>()

  constructor(
    readonly design: Size,
    private readonly sources: Scene3DSources = {}
  ) {
    this.camera.aspect = design.width / design.height
    const home = homeDistance(design)
    this.camera.near = Math.max(1, home * 0.01)
    this.camera.far = home * 60
    this.camera.updateProjectionMatrix()
  }

  /** The object built for an id, for the tests and for anyone reading the graph. */
  object(id: string): THREE.Object3D | undefined {
    return this.objects.get(id)?.root
  }

  /** Brings the graph in line with a scene: new objects built, changed ones built again, gone ones dropped. */
  set(spec: Scene3D): void {
    this.spec = spec
    const seen = new Set<string>()
    spec.objects.forEach((o, order) => {
      seen.add(o.id)
      const key = this.keyOf(o)
      const was = this.objects.get(o.id)
      if (was && was.key === key) {
        was.root.renderOrder = order
        return
      }
      if (was) this.drop(was)
      const built = this.build(o, key)
      built.root.name = o.id
      built.root.renderOrder = order
      this.scene.add(built.root)
      this.objects.set(o.id, built)
    })
    for (const [id, b] of this.objects)
      if (!seen.has(id)) {
        this.drop(b)
        this.objects.delete(id)
      }

    const lights = spec.lights.length ? spec.lights : defaultLights(this.design)
    const lit = new Set<string>()
    for (const l of lights) {
      lit.add(l.id)
      const key = `${l.type}|${l.color ?? ''}|${l.angle ?? ''}`
      const was = this.lights.get(l.id)
      if (was && was.key === key) continue
      if (was) this.dropLight(was)
      const light = makeLight(l)
      light.name = l.id
      this.scene.add(light)
      if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) this.scene.add(light.target)
      this.lights.set(l.id, { key, light })
    }
    for (const [id, b] of this.lights)
      if (!lit.has(id)) {
        this.dropLight(b)
        this.lights.delete(id)
      }
  }

  /** Every object, light and the camera where they are `local` seconds into a clip `length` long. */
  pose(local: number, length: number): void {
    for (const o of this.spec.objects) {
      const b = this.objects.get(o.id)
      if (!b) continue
      const p = objectPose(o, local, length)
      b.root.position.set(...p.position)
      b.root.rotation.set(p.rotation[0], p.rotation[1], p.rotation[2], 'XYZ')
      b.root.scale.setScalar(Math.abs(p.scale) < 1e-6 ? 1e-6 : p.scale)
      b.root.visible = p.opacity > 0.002
      for (const { m, opacity, transparent } of b.materials) {
        const fades = p.opacity < 0.999
        const see = transparent || fades
        if (m.transparent !== see) {
          m.transparent = see
          m.needsUpdate = true
        }
        m.opacity = opacity * p.opacity
        m.depthWrite = !fades && !transparent
      }
      if (b.texture) this.freshen(o, b, local)
    }
    const lights = this.spec.lights.length ? this.spec.lights : defaultLights(this.design)
    for (const l of lights) {
      const b = this.lights.get(l.id)
      if (!b) continue
      const light = b.light
      light.intensity = Math.max(0, num(l.intensity, local, length, 1)) * LEVEL
      light.position.set(num(l.x, local, length, 0), num(l.y, local, length, 0), num(l.z, local, length, homeDistance(this.design)))
      if (light instanceof THREE.SpotLight || light instanceof THREE.DirectionalLight)
        light.target.position.set(num(l.tx, local, length, 0), num(l.ty, local, length, 0), num(l.tz, local, length, 0))
    }
    const cam = cameraPose(this.spec.camera, this.design, local, length)
    this.camera.position.set(...cam.position)
    this.camera.up.set(0, 1, 0)
    this.camera.lookAt(...cam.target)
    if (this.camera.fov !== cam.fov) {
      this.camera.fov = cam.fov
      this.camera.updateProjectionMatrix()
    }
    this.scene.updateMatrixWorld(true)
  }

  dispose(): void {
    for (const b of this.objects.values()) this.drop(b)
    for (const b of this.lights.values()) this.dropLight(b)
    this.objects.clear()
    this.lights.clear()
  }

  /** What an object's build depends on, beyond its keys: its shape, its look, and whether its content is in yet. */
  private keyOf(o: Object3D): string {
    const { x: _x, y: _y, z: _z, rx: _rx, ry: _ry, rz: _rz, scale: _s, opacity: _o, name: _n, ...shape } = o
    let ready: unknown = null
    if (o.type === 'text') ready = !!this.sources.font?.(o.font ?? TITLE_3D_FACE)
    if (o.type === 'model') ready = !!o.src && !!this.sources.model?.(o.src)
    if (o.type === 'card') ready = this.cardAspect(o)
    return JSON.stringify([shape, ready])
  }

  /** A card's picture's shape once it is known, or null while it is not. */
  private cardAspect(o: Object3D): number | null {
    const pic = o.src ? this.sources.picture?.(o, 0) : null
    return pic && pic.width > 0 && pic.height > 0 ? Math.round((pic.width / pic.height) * 1000) / 1000 : null
  }

  private build(o: Object3D, key: string): Built {
    const group = new THREE.Group()
    const materials: Built['materials'] = []
    const own = (m: THREE.Material): void => {
      materials.push({ m, opacity: m.opacity, transparent: m.transparent })
    }
    const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh => {
      const m = new THREE.Mesh(geometry, material)
      own(material)
      group.add(m)
      return m
    }
    const out: Built = { key, root: group, materials }
    switch (o.type) {
      case 'card': {
        const { w, h } = cardSize(o, this.design, this.cardAspect(o))
        const r = o.radius ?? Math.min(w, h) * 0.04
        const shape = roundedRect(w, h, r)
        const depth = o.depth ?? 0
        const shows = !!o.src || !!o.title
        const back = standard(o, '#F2F2F0', 0, 0.6)
        if (depth > 0) {
          const body = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 8 })
          body.translate(0, 0, -depth / 2)
          mesh(body, back)
        } else {
          const rear = faceGeometry(shape, w, h)
          rear.rotateY(Math.PI)
          mesh(rear, back)
        }
        const front = faceGeometry(shape, w, h)
        front.translate(0, 0, depth / 2 + Math.max(0.25, depth * 0.01))
        if (shows) {
          const tex = new THREE.Texture()
          tex.colorSpace = THREE.SRGBColorSpace
          tex.generateMipmaps = false
          tex.minFilter = THREE.LinearFilter
          tex.magFilter = THREE.LinearFilter
          const face = new THREE.MeshBasicMaterial({ map: tex, color: 0xffffff, transparent: false })
          // Until its picture is in, the card shows its own colour.
          face.visible = false
          mesh(front, face)
          out.texture = { tex, face, stamp: null, from: o.src ? 'picture' : 'words' }
        } else mesh(front, standard(o, '#FFFFFF', 0, 0.6))
        break
      }
      case 'text': {
        const font = this.sources.font?.(o.font ?? TITLE_3D_FACE)
        if (!font || !o.text) break
        const size = titleSize(o, this.design, font)
        const depth = o.depth ?? size * 0.3
        const bevel = Math.min(size * 0.025, depth / 3)
        const geometry = new THREE.ExtrudeGeometry(titleShapes(font, o.text, size), {
          depth,
          curveSegments: 6,
          bevelEnabled: bevel > 0.01,
          bevelThickness: bevel,
          bevelSize: bevel * 0.6,
          bevelSegments: 2
        })
        geometry.translate(0, 0, -depth / 2)
        mesh(geometry, standard(o, '#FFFFFF', 0.1, 0.4))
        break
      }
      case 'box': {
        const w = o.w ?? 300
        mesh(new THREE.BoxGeometry(w, o.h ?? w, o.d ?? w), standard(o))
        break
      }
      case 'sphere':
        mesh(new THREE.SphereGeometry(o.radius ?? 150, 48, 32), standard(o))
        break
      case 'plane': {
        const m = standard(o)
        m.side = THREE.DoubleSide
        mesh(new THREE.PlaneGeometry(o.w ?? 600, o.h ?? 400), m)
        break
      }
      case 'cylinder': {
        const r = o.radius ?? 120
        mesh(new THREE.CylinderGeometry(r, r, o.h ?? 300, 48), standard(o))
        break
      }
      case 'torus':
        mesh(new THREE.TorusGeometry(o.radius ?? 160, o.tube ?? 50, 32, 96), standard(o))
        break
      case 'model': {
        const loaded = o.src ? this.sources.model?.(o.src) : null
        if (!loaded) break
        const model = loaded.clone(true)
        // Its longest side as big as `size`, its middle on the origin.
        const box = new THREE.Box3().setFromObject(model)
        const dims = box.getSize(new THREE.Vector3())
        const longest = Math.max(dims.x, dims.y, dims.z) || 1
        const k = (o.size ?? Math.min(this.design.width, this.design.height) * 0.5) / longest
        const centre = box.getCenter(new THREE.Vector3())
        const holder = new THREE.Group()
        model.position.sub(centre)
        holder.add(model)
        holder.scale.setScalar(k)
        model.traverse((n) => {
          const m = n as THREE.Mesh
          if (!m.isMesh) return
          // Its geometry is the loaded model's, shared with every copy: not this scene's to free.
          m.userData.shared = true
          m.material = Array.isArray(m.material) ? m.material.map((x) => x.clone()) : m.material.clone()
          for (const x of Array.isArray(m.material) ? m.material : [m.material]) own(x)
        })
        group.add(holder)
        break
      }
    }
    return out
  }

  /** A card's picture brought up to the moment: a video's next frame, or the picture once it has loaded. */
  private freshen(o: Object3D, b: Built, local: number): void {
    const t = b.texture
    if (!t) return
    let pic: Picture | null = null
    if (t.from === 'picture') pic = this.sources.picture?.(o, local) ?? null
    else {
      const { w, h } = cardSize(o, this.design, null)
      const k = Math.min(1, 2048 / Math.max(w, h))
      pic = this.sources.words?.(o, Math.round(w * k), Math.round(h * k)) ?? null
    }
    if (!pic) return
    if (pic.stamp !== t.stamp || t.tex.image !== pic.image) {
      t.tex.image = pic.image
      t.tex.needsUpdate = true
      t.stamp = pic.stamp
    }
    if (!t.face.visible) t.face.visible = true
  }

  private drop(b: Built): void {
    this.scene.remove(b.root)
    b.root.traverse((n) => {
      const m = n as THREE.Mesh
      if (m.isMesh && !m.userData.shared) m.geometry.dispose()
    })
    for (const { m } of b.materials) m.dispose()
    b.texture?.tex.dispose()
  }

  private dropLight(b: BuiltLight): void {
    this.scene.remove(b.light)
    if (b.light instanceof THREE.DirectionalLight || b.light instanceof THREE.SpotLight) this.scene.remove(b.light.target)
    b.light.dispose()
  }
}

function makeLight(l: Light3D): THREE.Light {
  const color = new THREE.Color(l.color ?? '#FFFFFF')
  switch (l.type) {
    case 'ambient':
      return new THREE.AmbientLight(color, LEVEL)
    case 'directional':
      return new THREE.DirectionalLight(color, LEVEL)
    case 'point':
      // No falloff: a scene measured in pixels is thousands of units across.
      return new THREE.PointLight(color, LEVEL, 0, 0)
    case 'spot':
      return new THREE.SpotLight(color, LEVEL, 0, rad(l.angle ?? 30), 0.3, 0)
  }
}

/** A renderer for 3D clips: transparent where nothing is drawn, colours as the 2D layers have them. */
export function createRenderer(canvas?: HTMLCanvasElement | OffscreenCanvas): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance'
  })
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.NoToneMapping
  renderer.setPixelRatio(1)
  return renderer
}

/** Draws a scene at a moment onto the renderer's canvas, `pixels` big. */
export function renderScene3D(renderer: THREE.WebGLRenderer, view: Scene3DView, spec: Scene3D, local: number, length: number, pixels: Size): void {
  view.set(spec)
  view.pose(local, length)
  const size = renderer.getSize(new THREE.Vector2())
  const w = Math.max(1, Math.round(pixels.width))
  const h = Math.max(1, Math.round(pixels.height))
  if (size.x !== w || size.y !== h) renderer.setSize(w, h, false)
  renderer.render(view.scene, view.camera)
}
