import { currentCut, resolveCut, type EditDoc } from '../edit'
import { graphicName } from '../motion/describe'
import { wordFor } from '../motion/commands'
import { mapProblem, readMapCommand } from './command'
import { normalize, readMapQuery } from './gazetteer'

/**
 * A request in words that asks for a map and nothing else ("show where
 * Iceland is", "show the Mid-Atlantic Ridge between the plates") is answered
 * here, with no model: the planner's quick path, so maps work without a key
 * and come back at once. A request that asks for more than a map goes to the
 * planner as usual, which knows the map graphic too.
 */

/** Words a map request is made of besides its places: what is left once these and the places are gone decides whether it is only a map. */
const FILLER = new Set(
  (
    'a an the of on in at to into onto me us show showing shows where wheres is are was it its this that here there now ' +
    'map maps mapped fly flying zoom zooming put add place drop give make let lets see look please can could would you i want need ' +
    'and with between from plates plate located location locate route path way flight graphic shot cutaway quick little ' +
    'documentary style then next after them both across over our my your up for' +
    ' s'
  ).split(' ')
)

/** How a request in words starts and ends around its places: "show me where … is", "a map of …", "where is …?". */
const LEAD =
  /^(?:(?:please|can you|could you|would you|i want|i need|let'?s|now|then)\s+)*(?:(?:show|give)(?:\s+(?:me|us))?\s+|put up\s+|add\s+|make\s+|fly\s+(?:in\s+)?(?:to|over)\s+|zoom\s+(?:in\s+)?(?:to|on|into)\s+)?(?:(?:a|the)\s+map\s+(?:of|showing)\s+)?(?:where\s+(?:is\s+|are\s+)?)?/i
const TRAIL = /(?:\s+(?:is|are|lies|sits|was|on the map|please))*\s*[?.!]*$/i

/** The places part of a request, so a graphic reads "the Mid-Atlantic Ridge between the plates", not "show the …". */
function placesOf(query: string): string {
  const cut = query.replace(LEAD, '').replace(TRAIL, '').trim()
  return cut || query
}

/** Something that says a map is wanted, so "Iceland" alone in a sentence about something else is not taken for one. */
const ASKS_FOR_A_MAP =
  /\b(map|where|located|location|locate|fly|zoom|route|path|plates?|ridge|rift|fault|trench|parallel|latitude|arctic circle|equator|tropic of)\b/

export type MapRequest =
  | { kind: 'map'; call: { kind: 'map'; from: string; text: string[]; style: string; place: string; fx: string[] }; name: string; said: boolean }
  | { kind: 'problem'; problem: string }

/** Reads a request as a map request; null when it is not only one. */
export function mapRequest(doc: EditDoc, request: string): MapRequest | null {
  const text = request.trim()
  if (!text || text.startsWith('/') || text.length > 240) return null
  const said = normalize(text)
  if (!ASKS_FOR_A_MAP.test(said)) return null
  const read = readMapCommand(text)
  const q = readMapQuery(read.query)
  if (q.stops.length === 0 && !q.ambiguous) return null
  // What is left once the places and the words any map request has are gone: nothing, for a map request.
  let rest = ` ${normalize(read.query)} `
  for (const m of [...q.matched].sort((a, b) => b.length - a.length)) rest = rest.replace(` ${normalize(m)} `, ' ')
  const left = rest.split(' ').filter((w) => w && !FILLER.has(w))
  if (left.length > 0) return null
  const problem = mapProblem(read.query)
  if (problem) return { kind: 'problem', problem }
  // On the word that names the place, the first time it is said; otherwise at the start of the cut.
  const cut = currentCut(doc)
  const resolved = resolveCut(cut, doc.words, doc.sources)
  const first = q.route?.from ?? q.stops[0]?.[0]
  // "Mid-Atlantic" is one word in a transcript.
  const at = first ? (wordFor(resolved, first.name, null) ?? wordFor(resolved, first.name.replace(/-/g, ''), null)) : null
  // The places part only, as long as it reads as the same map.
  const places = placesOf(read.query)
  const same = JSON.stringify(readMapQuery(places).stops.map((s) => s.map((p) => p.id))) === JSON.stringify(q.stops.map((s) => s.map((p) => p.id)))
  const call = {
    kind: 'map' as const,
    from: at ?? resolved.words[0]?.id ?? 'start',
    text: [same ? places : read.query],
    style: read.style,
    place: read.place === 'full' ? '' : read.place,
    fx: read.facts === null ? [] : read.facts.length ? read.facts : ['nofacts']
  }
  return { kind: 'map', call, name: graphicName({ ...call, to: '', items: [], values: [], box: [], icon: '', color: '', layers: [] }), said: at !== null }
}
