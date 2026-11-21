/**
 * What each service charges, from its own published prices, in US dollars.
 *
 * This is the one file to update when a price or a model changes: the quote,
 * the budget cap and the Settings page all read it. Every entry says where the
 * number comes from and when it was read. Prices exclude tax.
 *
 * Model names here are the services' own (what each API is asked for).
 */

/** When every price below was last read from its source. */
export const PRICES_CHECKED = '2026-11-16'

export interface ImagePrice {
  /** The API's model name. */
  model: string
  /** As the person would see it named. */
  name: string
  /** Dollars per image at each size the quote can ask for. */
  perImage: Record<string, number>
  /** The size asked for unless told otherwise. */
  size: string
  /** Dollars per reference image sent with a prompt. */
  perReference: number
  source: string
}

export interface ClipPrice {
  model: string
  name: string
  /** Dollars per second of video made, without sound. */
  perSecond: number
  /** The shortest and longest clip it makes, in seconds. */
  minSec: number
  maxSec: number
  source: string
}

export interface VoicePrice {
  model: string
  name: string
  /** Dollars per 1,000 characters read, or per second of speech made. Zero for a voice on this Mac. */
  perThousandChars: number
  perSecond: number
  /** Dates the price changes, and to what: a promotion ending, a rise announced. */
  from?: { date: string; perSecond?: number; perThousandChars?: number }[]
  source: string
}

export const PRICES = {
  images: {
    // https://aistudio.google.com/docs/pricing (gemini-nano-banana-2.1): image output at $30 per 1M tokens,
    // 1120 tokens a 1K image ($0.0336) and 1680 a 2K one ($0.0504); input at $1.50 per 1M, 1120 tokens a reference image.
    google: {
      model: 'gemini-nano-banana-2.1',
      name: 'Nano Banana 2.1',
      perImage: { '1K': 0.0336, '2K': 0.0504 },
      size: '2K',
      perReference: 0.00168,
      source: 'https://aistudio.google.com/docs/pricing'
    },
    // https://fal.ai/models/blackforestlabs/flux-3/text-to-image/llms.txt: "A 1K (1 MP) image costs $0.048";
    // https://fal.ai/pricing lists FLUX 3 at $0.048 per megapixel, so a 2K image (about 4 MP) is $0.192.
    // Reference images go through the edit endpoint at the same rate.
    fal: {
      model: 'blackforestlabs/flux-3/text-to-image',
      name: 'FLUX 3',
      perImage: { '1k': 0.048, '2k': 0.192 },
      size: '1k',
      perReference: 0,
      source: 'https://fal.ai/models/blackforestlabs/flux-3/text-to-image'
    }
  } satisfies Record<string, ImagePrice>,
  clips: {
    // https://aistudio.google.com/docs/pricing (gemini-omni-1.2-flash): video output at $12 per 1M tokens,
    // 5,792 tokens a second at 720p, "approximately $0.07 per second". 3 to 15 seconds a clip.
    google: {
      model: 'gemini-omni-1.2-flash',
      name: 'Gemini Omni Flash',
      perSecond: 0.0695,
      minSec: 3,
      maxSec: 15,
      source: 'https://aistudio.google.com/docs/omni'
    },
    // https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video/llms.txt: "$0.112 (audio off)" a second.
    fal: {
      model: 'fal-ai/kling-video/v3/pro/image-to-video',
      name: 'Kling 3.0 Pro',
      perSecond: 0.112,
      minSec: 3,
      maxSec: 15,
      source: 'https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video'
    }
  } satisfies Record<string, ClipPrice>,
  voices: {
    // Kokoro-82M, Apache-2.0, run on this Mac: https://huggingface.co/hexgrad/Kokoro-82M
    local: {
      model: 'Kokoro-82M v1.0',
      name: 'Kokoro',
      perThousandChars: 0,
      perSecond: 0,
      source: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX'
    },
    // https://elevenlabs.io/pricing/api: $0.08 per 1,000 characters on Multilingual v2, v3 and v4.
    elevenlabs: {
      model: 'eleven_multilingual_v2',
      name: 'ElevenLabs Multilingual v2',
      perThousandChars: 0.08,
      perSecond: 0,
      source: 'https://elevenlabs.io/pricing/api'
    },
    // https://aistudio.google.com/docs/pricing (gemini-3.8-flash-tts): audio output at $9 per 1M tokens through
    // December 31, 2026 and $18 from January 1, 2027, at 25 tokens a second; text input at $0.50 per 1M.
    gemini: {
      model: 'gemini-3.8-flash-tts',
      name: 'Gemini 3.8 Flash TTS',
      perThousandChars: 0,
      perSecond: 0.000225,
      from: [{ date: '2027-01-01', perSecond: 0.00045 }],
      source: 'https://aistudio.google.com/docs/speech-generation'
    }
  } satisfies Record<string, VoicePrice>,
  // The model the planner uses, with the person's own Anthropic key (src/main/planner.ts):
  // $4 per 1M input tokens and $20 per 1M output tokens. Prompt caching: a 5-minute cache write costs
  // 1.25 times an input token, a cache read 0.1 times.
  claude: {
    inputPerMillion: 4,
    outputPerMillion: 20,
    cacheWrite: 1.25,
    cacheRead: 0.1,
    source: 'https://platform.claude.com/docs/en/about-claude/pricing'
  }
} as const

export type VoicePriceKey = keyof typeof PRICES.voices

/** A voice's price per second and per 1,000 characters on a day, after any change announced for it. */
export function voiceRate(price: VoicePrice, today: string): { perSecond: number; perThousandChars: number } {
  let rate = { perSecond: price.perSecond, perThousandChars: price.perThousandChars }
  for (const change of [...(price.from ?? [])].sort((a, b) => a.date.localeCompare(b.date))) {
    if (today >= change.date)
      rate = {
        perSecond: change.perSecond ?? rate.perSecond,
        perThousandChars: change.perThousandChars ?? rate.perThousandChars
      }
  }
  return rate
}

/**
 * Up to this many times its estimate, one call to Claude may cost, and is
 * quoted at: the quote's Claude lines are what each call is held to while the
 * video is made (main/make/claude.ts holdFor), with its answer capped to what
 * that pays for. So Claude never takes the money of a picture that was quoted.
 */
export const CLAUDE_HOLD = 2

/** Output tokens a call to Claude always has room for, up to its own ceiling: thinking and a short answer. */
export const ROOM_TO_ANSWER = 8000

/** Phrases one call plans the shots of; a longer video's shot list is planned in parts. */
export const SHOTS_PER_PART = 40

/** Tokens a script and a shot list take with Claude, from what they hold: about four characters a token. */
export const CLAUDE_TOKENS = {
  /** The instructions and the ask, sent with each request. */
  promptBase: 3_500,
  /** Output tokens for the script, per second of narration it is for (at about 2.4 words a second). */
  scriptPerSecond: 3.6,
  /** Output tokens for each shot of the shot list. */
  perShot: 120,
  /** Thinking before answering, a share of the answer. */
  thinking: 0.6
}
