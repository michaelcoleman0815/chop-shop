/**
 * A small, forgiving XML reader for the files editing programs write, with
 * where every element sits in the text. Knowing where things are lets a
 * Premiere sequence be added to by inserting into its own text, so every
 * byte Premiere wrote stays as it wrote it.
 */

export interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  /** The element's own text, entities decoded, with its children's left out. */
  text: string
  /** Where its start tag begins and where its end tag ends. */
  start: number
  end: number
  /** Where its content begins and where its end tag begins; both are `end` for an empty element. */
  innerStart: number
  innerEnd: number
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** Text with its entities read: &amp;, &#38;, &#x26;. An unknown one is left as written. */
export function decodeXml(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z]+);/g, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[e] ?? whole
  })
}

/** Text made safe to write between tags or inside quotes. */
export function encodeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const NAME = /^[A-Za-z_:][\w:.-]*/

/**
 * The document as a tree under a #document node. Declarations, comments and
 * a DOCTYPE (with its internal subset) are skipped; CDATA is text. An end tag
 * that closes something further up closes everything in between, and a stray
 * one is ignored, so a slightly broken file still reads.
 */
export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '', start: 0, end: src.length, innerStart: 0, innerEnd: src.length }
  const stack: XmlNode[] = [root]
  const top = (): XmlNode => stack[stack.length - 1]
  let i = 0
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt < 0) {
      top().text += decodeXml(src.slice(i))
      break
    }
    if (lt > i) top().text += decodeXml(src.slice(i, lt))
    if (src.startsWith('<!--', lt)) {
      const close = src.indexOf('-->', lt + 4)
      i = close < 0 ? src.length : close + 3
      continue
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const close = src.indexOf(']]>', lt + 9)
      top().text += src.slice(lt + 9, close < 0 ? src.length : close)
      i = close < 0 ? src.length : close + 3
      continue
    }
    if (src.startsWith('<?', lt)) {
      const close = src.indexOf('?>', lt + 2)
      i = close < 0 ? src.length : close + 2
      continue
    }
    if (src.startsWith('<!', lt)) {
      // A DOCTYPE, whose internal subset may hold > of its own.
      let depth = 0
      let j = lt + 2
      for (; j < src.length; j++) {
        const c = src[j]
        if (c === '[') depth++
        else if (c === ']') depth--
        else if (c === '>' && depth <= 0) break
      }
      i = j + 1
      continue
    }
    if (src[lt + 1] === '/') {
      const close = src.indexOf('>', lt)
      const name = src.slice(lt + 2, close < 0 ? src.length : close).trim()
      i = close < 0 ? src.length : close + 1
      const at = stack.map((n) => n.name).lastIndexOf(name)
      if (at <= 0) continue
      while (stack.length > at) {
        const node = stack.pop() as XmlNode
        node.innerEnd = lt
        // The element named ends after its tag; one it closes on the way ends where that tag begins.
        node.end = stack.length === at ? i : lt
      }
      continue
    }
    const name = NAME.exec(src.slice(lt + 1, lt + 200))?.[0]
    if (!name) {
      top().text += '<'
      i = lt + 1
      continue
    }
    // The start tag, reading quoted values whole so a > inside one does not end it.
    let j = lt + 1 + name.length
    const attrs: Record<string, string> = {}
    let selfClosing = false
    while (j < src.length) {
      while (j < src.length && /\s/.test(src[j])) j++
      if (src[j] === '>') {
        j++
        break
      }
      if (src[j] === '/' && src[j + 1] === '>') {
        selfClosing = true
        j += 2
        break
      }
      const attr = NAME.exec(src.slice(j, j + 200))?.[0]
      if (!attr) {
        j++
        continue
      }
      j += attr.length
      while (j < src.length && /\s/.test(src[j])) j++
      if (src[j] !== '=') {
        attrs[attr] = ''
        continue
      }
      j++
      while (j < src.length && /\s/.test(src[j])) j++
      const q = src[j]
      if (q === '"' || q === "'") {
        const close = src.indexOf(q, j + 1)
        attrs[attr] = decodeXml(src.slice(j + 1, close < 0 ? src.length : close))
        j = close < 0 ? src.length : close + 1
      } else {
        const m = /^[^\s>]*/.exec(src.slice(j))?.[0] ?? ''
        attrs[attr] = decodeXml(m)
        j += m.length
      }
    }
    const node: XmlNode = { name, attrs, children: [], text: '', start: lt, end: j, innerStart: j, innerEnd: j }
    top().children.push(node)
    if (!selfClosing) stack.push(node)
    i = j
  }
  // Whatever is still open runs to the end of the text.
  while (stack.length > 1) {
    const node = stack.pop() as XmlNode
    node.innerEnd = src.length
    node.end = src.length
  }
  return root
}

/** The children with this name. */
export const childrenOf = (node: XmlNode | null | undefined, name: string): XmlNode[] =>
  node ? node.children.filter((c) => c.name === name) : []

/** The first child with this name, or null. */
export const childOf = (node: XmlNode | null | undefined, name: string): XmlNode | null =>
  node?.children.find((c) => c.name === name) ?? null

/** Down a path of child names: path(seq, 'media', 'video', 'format'). */
export function pathOf(node: XmlNode | null | undefined, ...names: string[]): XmlNode | null {
  let at: XmlNode | null = node ?? null
  for (const n of names) at = childOf(at, n)
  return at
}

/** A child's text, trimmed, or null when there is no such child. */
export function textOf(node: XmlNode | null | undefined, name: string): string | null {
  const c = childOf(node, name)
  return c ? c.text.trim() : null
}

/** A child's number, or the fallback when it is missing or not a number. */
export function numberOf(node: XmlNode | null | undefined, name: string, fallback: number): number {
  const t = textOf(node, name)
  const n = t === null || t === '' ? NaN : Number(t)
  return Number.isFinite(n) ? n : fallback
}

/** Every element with this name, at any depth, in document order. */
export function descendantsOf(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = []
  const walk = (n: XmlNode): void => {
    for (const c of n.children) {
      if (c.name === name) out.push(c)
      walk(c)
    }
  }
  walk(node)
  return out
}
