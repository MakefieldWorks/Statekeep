import { describe, expect, it } from 'vitest'
import { collectProjectOpenTargets, isDefaultAppPathTarget } from '../../../src/main/launch-arguments'
import { resolve } from 'path'

const appPath = '/Applications/Statekeep.app'

describe('collectProjectOpenTargets', () => {
  it('does not treat the default Electron app path as a project target', () => {
    expect(collectProjectOpenTargets(['/usr/local/bin/electron', '.'], {
      defaultApp: true,
      appPath,
    })).toEqual([])
  })

  it('keeps a project target passed after the default Electron app path', () => {
    expect(collectProjectOpenTargets([
      '/usr/local/bin/electron',
      '/Users/robert/Code/Statekeep/out/main/index.js',
      '/Users/robert/Documents/Network Lab',
    ], {
      defaultApp: true,
      appPath: '/Users/robert/Code/Statekeep',
    })).toEqual(['/Users/robert/Documents/Network Lab'])
  })

  it('keeps a project target for a packaged application while ignoring flags', () => {
    expect(collectProjectOpenTargets([
      '/Applications/Statekeep.app/Contents/MacOS/Statekeep',
      '--user-data-dir=/tmp/statekeep',
      '/Users/robert/Documents/Network Lab',
    ], {
      defaultApp: false,
      appPath,
    })).toEqual(['/Users/robert/Documents/Network Lab'])
  })

  it('does not discard later open targets that happen to look like scripts', () => {
    expect(collectProjectOpenTargets([
      '/Applications/Statekeep.app/Contents/MacOS/Statekeep',
      '/Applications/Statekeep.app/Contents/Resources/app.asar/out/main/index.js',
      '/Applications/Statekeep.app/Contents/Resources/example.js',
    ], {
      defaultApp: false,
      appPath,
    })).toEqual(['/Applications/Statekeep.app/Contents/Resources/example.js'])
  })
})

describe('isDefaultAppPathTarget', () => {
  it('ignores an open-file for the unpackaged app folder (macOS `electron .`)', () => {
    expect(isDefaultAppPathTarget('.', { defaultApp: true, appPath: process.cwd() })).toBe(true)
    expect(isDefaultAppPathTarget(resolve('.') + '/', { defaultApp: true, appPath: process.cwd() })).toBe(true)
  })

  it('keeps real targets, and every target in a packaged app', () => {
    expect(isDefaultAppPathTarget('/Users/robert/Documents/Network Lab', { defaultApp: true, appPath: process.cwd() })).toBe(false)
    expect(isDefaultAppPathTarget('.', { defaultApp: false, appPath: process.cwd() })).toBe(false)
  })
})
