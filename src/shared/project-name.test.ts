import { describe, expect, it } from 'vitest'
import { notADevice, PROJECT_NAME_CHARS, projectName } from './project-name'
import { onWindows } from './platform'

describe('naming a project', () => {
  it('keeps a file name as it is, less the characters a file name cannot have', () => {
    expect(projectName('MVI_9293')).toBe('MVI_9293')
    expect(projectName('Review: iPhone 17 / Pixel 10')).toBe('Review- iPhone 17 - Pixel 10')
  })

  it('makes a typed paragraph a short name on one line, cut where a word ends', () => {
    const said =
      'I want to make a video about the new phone,\nhow the camera does at night, and why the battery lasts two days. Keep it punchy.'
    const name = projectName(said)
    expect(name).toBe('I want to make a video about the new phone, how')
    expect(Array.from(name).length).toBeLessThanOrEqual(PROJECT_NAME_CHARS)
    expect(name).not.toContain('\n')
  })

  it('never splits a character in two, and fits any file system', () => {
    const name = projectName('🎬'.repeat(80))
    expect(Array.from(name).every((c) => c === '🎬')).toBe(true)
    expect(Buffer.byteLength(`${name} 12.cutalong`)).toBeLessThanOrEqual(255)
  })

  it('does not hide the file or leave it nameless', () => {
    expect(projectName('.env notes')).toBe('env notes')
    expect(projectName('   \n ')).toBe('Untitled')
  })

  it('never takes a name Windows keeps for a device, there', () => {
    for (const device of ['Con', 'aux', 'NUL', 'com1', 'LPT9', 'nul.backup'])
      expect(notADevice(device)).toBe(device.replace(/^[^.]*/, (first) => `${first}_`))
    for (const fine of ['Conference', 'Aux cables', 'com10', 'Nullify', 'My con'])
      expect(notADevice(fine)).toBe(fine)
    expect(projectName('Con')).toBe(onWindows ? 'Con_' : 'Con')
  })
})
