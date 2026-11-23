import type { Cut } from '../shared/edit'
import { tracksOf } from '../shared/tracks'
import type { FamilyGuide } from './planner-guides'

/**
 * Masks, mattes, keying and following, for the planner (planner-guides): a
 * line always in its instructions, and the full guide with a request that
 * speaks of them or an edit that already uses them. Every one of these rides
 * in a clip's spec on clip-add and clip-update (shared/tracks/roto), so the
 * plan's schema gains nothing.
 */

/** Words a person uses for these. A music or layer track is not following anything. */
const ASKS =
  /\b(masks?|masked|masking|roto(scop\w*)?|mattes?|behind (me|him|her|them|us|the (speaker|person|host|presenter|guy|girl|man|woman))|cut(ting)? (me |him |her |them |it )?out|cut-?outs?|green ?screen|blue ?screen|chroma|key(ing|ed)? (it |that |the \w+ )?out|keyed|(?<!(music|sound|audio|picture|layer|video|new|another|top|bottom|second|first) )track(s|ed|ing)?|follow(s|ed|ing)?)\b/i

/** Whether the cut already masks, mattes, keys or follows anything. */
const usesRoto = (cut: Cut): boolean =>
  tracksOf(cut).some((t) => t.clips.some((c) => (c.masks?.length ?? 0) > 0 || !!c.matte || !!c.key || !!c.follow))

export const ROTO_GUIDE: FamilyGuide = {
  name: 'mattes',
  index:
    'mattes: masks on a clip (ovals, boxes or drawn paths, feathered, grown, inverted, combined, keyframed), a track matte from the person, an object or another clip (inverted, a clip sits behind the speaker), a chroma key for a green screen, and a clip or mask following an object, all in a clip\'s spec on clip-add and clip-update.',
  wanted: (ask, cut) => ASKS.test(ask) || usesRoto(cut),
  guide: () => `## Masks, mattes, keying and following
All of these go in a clip's "spec" on clip-add or clip-update, and show the same in the editor and the export. A clip in <tracks> lists what it has now; "masks" in a spec replaces the clip's masks, so carry over those it keeps.
- {"op":"clip-update","clip":"c2","track":"","from":"","to":"","spec":"{\\"masks\\":[{\\"ellipse\\":[660,240,600,600],\\"feather\\":40}]}"}: cuts c2 to an oval with a soft edge. A mask is "ellipse" or "rect" as [x, y, width, height], or "path", its points [x, y] for a corner or [x, y, inX, inY, outX, outY] for a curve (handles as offsets), all in pixels of the full-size frame as the clip sits before it is moved. "feather" softens its edge, "expand" grows it (below 0 shrinks it), "invert" keeps what is outside, "opacity", and "mode" add, subtract or intersect with the masks before it, in order.
- {"op":"clip-update","clip":"c2","track":"","from":"","to":"","spec":"{\\"masks\\":[{\\"ellipse\\":{\\"keys\\":[{\\"t\\":0,\\"v\\":[200,300,500,500]},{\\"t\\":2,\\"v\\":[1200,300,500,500],\\"ease\\":\\"easy-ease\\"}]},\\"feather\\":60}]}"}: a spotlight that slides across over two seconds: a box, a path or any setting may be keyframes, and a path moves point by point between keys.
- {"op":"clip-add","kind":"text","track":"","src":"","text":"FOCUS","color":"","from":"w12","to":"4s","in":0,"speed":0,"fit":"","blend":"","opacity":0,"volume":0,"spec":"{\\"matte\\":{\\"from\\":\\"person\\",\\"invert\\":true},\\"text\\":{\\"size\\":420}}"}: a big title behind the speaker, who stays in front of it. A "matte" is "from" person, objects (every object Vision cut out), object:<n> (one), or clip:<id> (another clip, which then only cuts and is not drawn); "mode" alpha, or luma for its brightness; "invert" for everywhere but there. Without a cut-out (off a Mac) the clip shows whole.
- {"op":"clip-update","clip":"c3","track":"","from":"","to":"","spec":"{\\"key\\":{\\"colour\\":\\"#00FF00\\",\\"tolerance\\":0.35,\\"softness\\":0.15,\\"spill\\":0.5}}"}: takes a green screen out of a video or picture clip: "tolerance" how near the colour goes (0 to 1), "softness" how its edge fades back, "spill" how much green cast comes off what stays. A blue screen is "#0000FF".
- {"op":"clip-update","clip":"c4","track":"","from":"","to":"","spec":"{\\"follow\\":{\\"scale\\":true}}"}: c4 moves with the thing held up in the picture as it starts, and grows and shrinks as it nears or goes; "box" [x, y, w, h] as shares of the picture names what to follow instead. A mask takes its own "follow" the same way: on a video clip it follows what it covers in that video. Following needs a Mac; elsewhere the clip stays where it is put.
- {"op":"clip-update","clip":"c2","track":"","from":"","to":"","spec":"{\\"masks\\":[],\\"matte\\":null,\\"key\\":null,\\"follow\\":null}"}: takes every mask, the matte, the key and the following off c2.
Plain words: "rotoscope", "cut me out", "put it behind me" is a matte from person, inverted; "only on me" is the same not inverted; "green screen", "key out the green" is a key; "spotlight", "vignette" is a feathered oval mask (inverted, on a dark solid, for a vignette); "stick it to the phone", "track it" is a follow.`
}
