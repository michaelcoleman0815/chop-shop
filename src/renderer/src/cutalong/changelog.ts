import text from '../../../../CHANGELOG.md?raw'
import { parseChangelog } from '../../../shared/changelog'

/** What changed in each version, newest first, from CHANGELOG.md as the app was built (shared/changelog). */
export const CHANGES = parseChangelog(text)
