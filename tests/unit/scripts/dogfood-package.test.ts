import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses'
// @ts-expect-error Packaging helper is intentionally a standalone Node module.
import { prepareDogfoodPackage } from '../../../scripts/dogfood-package.mjs'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('packaged dogfood instrumentation', () => {
  it('enables only the inspector in a disposable package copy and leaves the release untouched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'statekeep-dogfood-test-')); directories.push(root)
    const packageDir = join(root, 'linux-unpacked'); mkdirSync(join(packageDir, 'resources'), { recursive: true })
    const executable = join(packageDir, 'statekeep')
    // Genuine fuse-wire layout in a tiny synthetic executable. The package
    // helper uses the real @electron/fuses reader/writer, not mocked calls.
    const original = Buffer.concat([Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, 9]), Buffer.from('000001110')])
    writeFileSync(executable, original)
    writeFileSync(join(packageDir, 'resources', 'app.asar'), 'unchanged application contents')
    const instrumented = await prepareDogfoodPackage(executable, 'linux')
    try {
      expect(instrumented.executable).not.toBe(executable)
      expect(readFileSync(executable)).toEqual(original)
      expect(readFileSync(join(instrumented.executable, '..', 'resources', 'app.asar'), 'utf8')).toBe('unchanged application contents')
      const before = await getCurrentFuseWire(executable)
      const after = await getCurrentFuseWire(instrumented.executable)
      expect(after).toEqual({ ...before, [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.ENABLE })
    } finally { instrumented.cleanup() }
    expect(existsSync(instrumented.executable)).toBe(false)
    expect(readFileSync(executable)).toEqual(original)
  })
})
