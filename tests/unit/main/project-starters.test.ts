import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { PROJECT_STARTERS } from '../../../src/shared/project-starters'
import { createStarterProject } from '../../../src/main/project-starters'
import { GitService } from '../../../src/main/git-service'
import { ProjectManager } from '../../../src/main/project-manager'

const logger = { error() {}, warn() {}, info() {}, debug() {} }
let parent: string
let manager: ProjectManager
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'statekeep-starters-'))
  manager = new ProjectManager(new GitService(logger as any), logger as any)
})
afterEach(async () => {
  manager.cancelAutosave()
  if (manager.getCurrent()) await manager.flushAndClose()
  await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
describe('bundled project starters', () => {
  for (const starter of PROJECT_STARTERS) {
    it(`creates editable, independently reopenable ${starter.id} history`, async () => {
      const result = await createStarterProject(manager, { starterId: starter.id, name: 'My project', parentPath: parent })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.nodes.length).toBe(5)
      expect(Object.keys(result.data.templates ?? {})).toHaveLength(2)
      const snapshots = await manager.snapshotList()
      expect(snapshots.ok && snapshots.data.map(item => item.name).sort()).toEqual(['baseline', 'configuration-update'])
      const compare = await manager.snapshotCompare('baseline', 'configuration-update')
      expect(compare.ok).toBe(true)
      if (compare.ok) expect(compare.data.length).toBeGreaterThan(0)
      const updated = manager.nodeUpdate(result.data.nodes[1]!.id, { name: 'My own location' })
      expect(updated.ok).toBe(true)
      expect((await manager.snapshotCreate('my-changes', 'User edits')).ok).toBe(true)
      const path = result.data.path!
      await manager.flushAndClose()
      const reopened = await manager.openProject(path)
      expect(reopened.ok && reopened.data.nodes.some(node => node.name === 'My own location')).toBe(true)
    })
  }

  it('serializes concurrent creation requests', async () => {
    const request = { starterId: 'lab', name: 'Concurrent', parentPath: parent }
    const [first, second] = await Promise.all([createStarterProject(manager, request), createStarterProject(manager, request)])
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.message).toContain('Wait')
  })
  it('surfaces a partial project for recovery after a snapshot write fails', async () => {
    vi.spyOn(manager, 'snapshotCreate').mockResolvedValueOnce({ ok: false, error: { code: 'AUTOSAVE_WRITE_FAILED', message: 'Disk full' } })
    const result = await createStarterProject(manager, { starterId: 'lab', name: 'Partial', parentPath: parent })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.context?.starterProjectPath).toBe(join(parent, 'Partial'))
    expect(manager.getCurrent()?.nodes.length).toBe(4)
  })
  it('rejects unknown/malformed starters and preserves existing destination content', async () => {
    for (const request of [null, {}, { starterId: '__proto__', name: 'Project', parentPath: parent }, { starterId: 'lab', name: '../escape', parentPath: parent }, { starterId: 'lab', name: 'Valid', parentPath: 'relative' }]) {
      expect((await createStarterProject(manager, request)).ok).toBe(false)
    }
    mkdirSync(join(parent, 'Existing'))
    writeFileSync(join(parent, 'Existing', 'important.txt'), 'preserve me')
    const result = await createStarterProject(manager, { starterId: 'lab', name: 'Existing', parentPath: parent })
    expect(result.ok).toBe(false)
    expect(readFileSync(join(parent, 'Existing', 'important.txt'), 'utf8')).toBe('preserve me')
    expect(manager.getCurrent()).toBeNull()
  })
})
