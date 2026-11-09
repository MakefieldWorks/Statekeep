import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { resolveProjectOpenTarget } from '../../../src/main/project-open-target'

let tmpDir: string

beforeEach(() => {
  tmpDir = join(tmpdir(), `statekeep-open-target-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

function writeProject(name = 'Lab'): string {
  const projectDir = join(tmpDir, name)
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'Statekeep.statekeep'), '{}', 'utf8')
  return projectDir
}

describe('resolveProjectOpenTarget', () => {
  it('accepts a project directory containing Statekeep.statekeep', () => {
    const projectDir = writeProject()

    expect(resolveProjectOpenTarget(projectDir)).toEqual({ ok: true, data: projectDir })
  })

  it('accepts a Statekeep.statekeep file and resolves to its project directory', () => {
    const projectDir = writeProject()

    expect(resolveProjectOpenTarget(join(projectDir, 'Statekeep.statekeep'))).toEqual({ ok: true, data: projectDir })
  })

  it('rejects a .statekeep file that is not its folder\'s project document', () => {
    const projectDir = writeProject('Copied Lab')
    const copy = join(projectDir, 'Copy.statekeep')
    writeFileSync(copy, '{}', 'utf8')

    const result = resolveProjectOpenTarget(copy)

    expect(result.ok).toBe(false)
  })

  it('rejects unsupported files', () => {
    const path = join(tmpDir, 'notes.txt')
    writeFileSync(path, 'not a project', 'utf8')

    const result = resolveProjectOpenTarget(path)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('expected a Statekeep project folder or .statekeep file')
  })

  it('rejects an existing folder that is not a Statekeep project', () => {
    const folder = join(tmpDir, 'Not A Project')
    mkdirSync(folder)

    const result = resolveProjectOpenTarget(folder)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('no Statekeep project document was found')
  })

  it('rejects a missing path', () => {
    expect(resolveProjectOpenTarget(join(tmpDir, 'missing')).ok).toBe(false)
  })
})
