/**
 * Finding sung music in a recording lives in shared/clipping/worship, where
 * /clipping reads it too; the classic clip finder still imports it from here.
 */
export {
  detectMusic,
  overlapsMusic,
  DEFAULT_MUSIC,
  type MusicRegion,
  type MusicOptions
} from '../shared/clipping/worship'
