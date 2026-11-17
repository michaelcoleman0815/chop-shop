import { describe, expect, it } from 'vitest'
import * as computer from '../../../src/shared/platform'
import * as phone from './platform'

/** The phone's page builds src/shims/platform.ts in place of src/shared/platform.ts (vite.config.ts). */
describe('the phone’s platform words', () => {
  it('names everything the computer’s words name, as the same kind of thing', () => {
    const own = phone as Record<string, unknown>
    for (const [name, value] of Object.entries(computer)) {
      expect(own, name).toHaveProperty(name)
      expect(typeof own[name], name).toBe(typeof value)
    }
  })

  it('says this phone, the iPhone’s Keychain or the Android Keystore, and Photos or Files', () => {
    const ios = phone.phoneWords('ios')
    const android = phone.phoneWords('android')
    for (const w of [ios, android]) {
      expect(w.onWindows).toBe(false)
      expect(w.thisComputer).toBe('this phone')
      expect(w.ThisComputer).toBe('This phone')
      expect(`${w.KEY_UNREADABLE} ${w.KEY_PLACE} ${w.SHOW_FILE}`).not.toMatch(/Mac|Finder|computer|Windows/)
    }
    expect(ios.KEY_PLACE).toBe("locked in this iPhone's Keychain")
    expect(android.KEY_PLACE).toBe("locked in this phone's Android Keystore")
    expect(ios.KEY_UNREADABLE).toBe("I could not open the saved key from this iPhone's Keychain. Paste it again.")
    expect(android.KEY_UNREADABLE).toBe("I could not open the saved key from this phone's Android Keystore. Paste it again.")
    expect(ios.SHOW_FILE).toBe('Show in Photos')
    expect(android.SHOW_FILE).toBe('Show in Files')
  })

  it('follows the phone the engine reports', () => {
    phone.phoneIs('android')
    expect(phone.KEY_PLACE).toBe("locked in this phone's Android Keystore")
    expect(phone.KEYCHAIN).toBe("this phone's Android Keystore")
    phone.phoneIs('ios')
    expect(phone.KEY_PLACE).toBe("locked in this iPhone's Keychain")
    expect(phone.SHOW_FILE).toBe('Show in Photos')
  })
})
