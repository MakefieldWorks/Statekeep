import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { EXAMPLE_PROJECT_NAME, openExampleProject } from '../../../src/main/example-project'
import { GitService } from '../../../src/main/git-service'
import { ProjectManager } from '../../../src/main/project-manager'

const noopLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
}

let parentDir: string
let manager: ProjectManager

beforeEach(() => {
  parentDir = join(tmpdir(), `statekeep-example-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(parentDir, { recursive: true })
  manager = new ProjectManager(new GitService(noopLogger as any), noopLogger as any)
})

afterEach(async () => {
  manager.cancelAutosave()
  if (manager.getCurrent()) await manager.flushAndClose()
  await rm(parentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

describe('openExampleProject', () => {
  it('creates a reusable project with templates and comparable snapshots', async () => {
    const created = await openExampleProject(manager, parentDir)

    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.path).toBe(join(parentDir, EXAMPLE_PROJECT_NAME))
    expect(created.data.nodes.map((node) => node.name)).toEqual([
      EXAMPLE_PROJECT_NAME,
      'Systems Room',
      'Rack A',
      'Navigation Controller',
      'Power Supply',
      'Telemetry Gateway',
    ])
    expect(created.data.templates).toHaveProperty('location')
    expect(created.data.templates).toHaveProperty('device')

    const snapshots = await manager.snapshotList()
    expect(snapshots.ok).toBe(true)
    if (!snapshots.ok) return
    expect(snapshots.data.map((snapshot) => snapshot.name).sort()).toEqual([
      'baseline-lab',
      'firmware-update',
    ])
    expect(snapshots.data.find((snapshot) => snapshot.name === 'baseline-lab')?.note)
      .toContain('Known-good navigation lab')
    expect(snapshots.data.find((snapshot) => snapshot.name === 'firmware-update')?.note)
      .toContain('telemetry gateway added')

    const reopened = await openExampleProject(manager, parentDir)
    expect(reopened.ok).toBe(true)
    if (!reopened.ok) return
    expect(reopened.data.path).toBe(created.data.path)
  })

  it('reports a project collision without claiming the folder is missing', async () => {
    mkdirSync(join(parentDir, EXAMPLE_PROJECT_NAME))

    const result = await openExampleProject(manager, parentDir)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PROJECT_EXISTS')
    expect(result.error.message).toContain('already exists')
  })
})
