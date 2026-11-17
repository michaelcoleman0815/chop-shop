import type { BrollIntent, Moment } from './types'

/**
 * Ten generic moments from tech, gaming and church videos, with what each
 * wants, for the router's tests and its live run. Nobody real is named.
 */

const moment = (search: string, said: string, over: Partial<Moment> = {}): Moment => ({
  said,
  search,
  topic: '',
  format: 'long',
  output: { width: 1920, height: 1080 },
  seconds: 4,
  ...over
})

export const TEN_MOMENTS: { m: Moment; intent: BrollIntent }[] = [
  { m: moment('laptop keyboard close up', 'the keyboard on this new laptop feels great', { niche: 'tech' }), intent: 'product' },
  { m: moment('streaming service price increase', 'a streaming service raises its prices again', { niche: 'tech' }), intent: 'news' },
  { m: moment('sci-fi film trailer', 'the trailer for the new sci-fi film dropped today', { niche: 'tech' }), intent: 'product' },
  { m: moment('company logo', 'and you can see the brand logo on the box', { niche: 'tech' }), intent: 'logo' },
  { m: moment('open world game gameplay', 'the boss fight in this game took me three hours', { niche: 'gaming' }), intent: 'game' },
  { m: moment('shocked reaction', 'I could not believe it, I was shocked', { niche: 'gaming' }), intent: 'reaction' },
  { m: moment('rocket launch', 'it went up like a rocket launch', { niche: 'tech' }), intent: 'space' },
  {
    m: moment('congregation singing in church', 'when we all sing together on a Sunday', {
      niche: 'church',
      format: 'short',
      output: { width: 1080, height: 1920 }
    }),
    intent: 'people'
  },
  { m: moment('sunrise over the hills', 'a new morning, a new mercy', { niche: 'church' }), intent: 'nature' },
  { m: moment('1950s family dinner', 'back in the fifties families ate together every night', { niche: 'church' }), intent: 'archival' }
]
