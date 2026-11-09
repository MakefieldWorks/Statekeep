import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ProjectManager } from '../../../src/main/project-manager'
import { GitService } from '../../../src/main/git-service'
import { HistoryBackupStore } from '../../../src/main/history-backup'

const logger = { error() {}, warn() {}, info() {}, debug() {} }
let manager: ProjectManager
let root: string
let path: string
let historyPath: string
let recovery: string
const name = 'recovery-unlisted.document.json'

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'statekeep-reconcile-'))
  manager = new ProjectManager(new GitService(logger as any), logger as any)
  const result = await manager.createProject('Reconciliation', root)
  if (!result.ok) throw new Error(result.error.message)
  path = result.data.path!
  historyPath = join(path, '.statekeep', 'history.json')
  recovery = join(path, '.statekeep', 'recovery')
  await manager.snapshotCreate('baseline')
  mkdirSync(recovery, { recursive: true })
  writeFileSync(join(recovery, name), JSON.stringify(manager.getCurrent()))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await manager.waitForHistoryBackfill()
  await manager.flushAndClose()
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
async function preview() {
  const result = await manager.recoveryFilesPreview()
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}
async function adopt() {
  const result = await manager.adoptRecoveryFile({ token: (await preview()).token, name })
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

describe('recovery file reconciliation', () => {
  it('previews without writes, registers without changing inventory or lineage, then recovers separately', async () => {
    manager.nodeCreate(manager.getCurrent()!.nodes[0].id, 'Unsaved rack')
    const project = structuredClone(manager.getCurrent())
    const undo = manager.editHistoryState()
    const bytes = readFileSync(historyPath)
    const payload = readFileSync(join(recovery, name))
    const scan = await preview()
    expect(scan.files).toMatchObject([{ name, eligible: true, nodeCount: 1 }])
    expect(readFileSync(historyPath)).toEqual(bytes)
    const point = await adopt()
    expect(point.reason).toBe('reconciled')
    expect(point.id).not.toBe('recovery-unlisted')
    expect(manager.getCurrent()).toEqual(project)
    expect(manager.editHistoryState()).toEqual(undo)
    const before = JSON.parse(bytes.toString())
    const after = JSON.parse(readFileSync(historyPath, 'utf8'))
    expect(after.events).toEqual(before.events)
    expect(after.currentBaseSnapshotId).toBe(before.currentBaseSnapshotId)
    expect(after.pendingRevertEventId).toBe(before.pendingRevertEventId)
    expect(readFileSync(join(recovery, name))).toEqual(payload)
    expect((await preview()).files).toEqual([])
    expect((await manager.recoveryPointApply({ id: point.id })).ok).toBe(true)
    expect(manager.getCurrent()!.nodes).toHaveLength(1)
  })

  it.each(['payload', 'metadata', 'inventory'])('rejects stale preview after %s changes', async change => {
    const scan = await preview()
    if (change === 'payload') writeFileSync(join(recovery, name), readFileSync(join(recovery, name), 'utf8') + '\n')
    if (change === 'metadata') writeFileSync(historyPath, readFileSync(historyPath, 'utf8') + '\n')
    if (change === 'inventory') writeFileSync(join(recovery, 'other.txt'), 'new file')
    const bytes = readFileSync(historyPath)
    expect(await manager.adoptRecoveryFile({ token: scan.token, name })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(readFileSync(historyPath)).toEqual(bytes)
  })

  it.each(['malformed', 'foreign', 'future', 'symlink', 'directory', 'filename'])('leaves %s files ineligible and untouched', async fault => {
    let target = name
    if (fault === 'malformed') writeFileSync(join(recovery, name), '{bad')
    if (fault === 'foreign') writeFileSync(join(recovery, name), JSON.stringify({ ...manager.getCurrent(), id: 'foreign' }))
    if (fault === 'future') {
      const payload = JSON.parse(readFileSync(join(recovery, name), 'utf8'))
      payload.version = 999
      writeFileSync(join(recovery, name), JSON.stringify(payload))
    }
    if (fault === 'symlink' || fault === 'directory') {
      rmSync(join(recovery, name))
      if (fault === 'symlink') symlinkSync(historyPath, join(recovery, name))
      else mkdirSync(join(recovery, name))
    }
    if (fault === 'filename') {
      target = 'unknown.json'
      writeFileSync(join(recovery, target), readFileSync(join(recovery, name)))
    }
    const scan = await preview()
    expect(scan.files.find(file => file.name === target)?.eligible).toBe(false)
    expect((await manager.adoptRecoveryFile({ token: scan.token, name: target })).ok).toBe(false)
    expect(existsSync(join(recovery, target))).toBe(true)
  })

  it('rejects path traversal and repeated registration', async () => {
    const scan = await preview()
    expect((await manager.adoptRecoveryFile({ token: scan.token, name: '../outside.json' })).ok).toBe(false)
    await adopt()
    expect((await manager.adoptRecoveryFile({ token: scan.token, name })).ok).toBe(false)
  })

  it('blocks damaged metadata and backup failures before registration', async () => {
    const scan = await preview()
    const bytes = readFileSync(historyPath)
    vi.spyOn(HistoryBackupStore.prototype, 'save').mockImplementation(() => { throw new Error('backup failed') })
    expect((await manager.adoptRecoveryFile({ token: scan.token, name })).ok).toBe(false)
    expect(readFileSync(historyPath)).toEqual(bytes)
    vi.restoreAllMocks()
    writeFileSync(historyPath, '{damaged')
    expect(await manager.recoveryFilesPreview()).toMatchObject({ ok: false, error: { code: 'HISTORY_METADATA_UNAVAILABLE' } })
  })

  it('rejects an added payload replaced by a foreign project before recovery', async () => {
    const point = await adopt()
    const current = structuredClone(manager.getCurrent())
    writeFileSync(join(recovery, name), JSON.stringify({ ...current, id: 'foreign-project' }))
    expect((await manager.recoveryPointApply({ id: point.id })).ok).toBe(false)
    expect(manager.getCurrent()).toEqual(current)
  })

  it('rejects recovery directory links without following them', async () => {
    const external = join(root, 'external')
    mkdirSync(external)
    rmSync(recovery, { recursive: true })
    symlinkSync(external, recovery)
    expect((await manager.recoveryFilesPreview()).ok).toBe(false)
  })

  it('rejects reconciliation while another history operation holds the lock', async () => {
    const scan = await preview()
    const original = HistoryBackupStore.prototype.save
    let competing: ReturnType<ProjectManager['adoptRecoveryFile']> | undefined
    vi.spyOn(HistoryBackupStore.prototype, 'save').mockImplementation(function (history) {
      competing ??= manager.adoptRecoveryFile({ token: scan.token, name })
      original.call(this, history)
    })
    expect((await manager.snapshotCreate('next')).ok).toBe(true)
    expect(await competing).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect((await preview()).files.some(file => file.name === name && file.eligible)).toBe(true)
  })

  it('retains added files when automatic recovery points are pruned', async () => {
    const point = await adopt()
    for (let i = 0; i < 11; i++) {
      manager.nodeCreate(manager.getCurrent()!.nodes[0].id, `Rack ${i}`)
      expect((await manager.snapshotRevert({ name: 'baseline' })).ok).toBe(true)
    }
    const history = JSON.parse(readFileSync(historyPath, 'utf8'))
    expect(history.recoveryPoints).toHaveLength(11)
    expect(history.recoveryPoints.some((p: { id: string }) => p.id === point.id)).toBe(true)
    expect(existsSync(join(recovery, name))).toBe(true)
  })

  it('bounds scans and skips hidden files', async () => {
    writeFileSync(join(recovery, '.DS_Store'), 'metadata')
    for (let i = 0; i < 105; i++) writeFileSync(join(recovery, `other-${i}.txt`), 'unknown')
    const scan = await preview()
    expect(scan.files).toHaveLength(100)
    expect(scan.uninspectedCount).toBe(6)
    expect(scan.files.some(file => file.name.startsWith('.'))).toBe(false)
  })

  it.each([false, true])('removes registration while preserving files and events (missing payload: %s)', async missing => {
    const point = await adopt()
    const payload = readFileSync(join(recovery, name))
    const history = JSON.parse(readFileSync(historyPath, 'utf8'))
    if (missing) rmSync(join(recovery, name))
    expect((await manager.forgetRecoveryFile({ id: point.id })).ok).toBe(true)
    const after = JSON.parse(readFileSync(historyPath, 'utf8'))
    expect(after.recoveryPoints).toEqual([])
    expect(after.events).toEqual(history.events)
    if (!missing) {
      expect(readFileSync(join(recovery, name))).toEqual(payload)
      expect((await preview()).files.find(file => file.name === name)?.eligible).toBe(true)
    }
    expect(JSON.parse(readFileSync(join(path, '.statekeep', 'history.backup.json'), 'utf8')).history).toEqual(after)
    expect((await manager.forgetRecoveryFile({ id: point.id })).ok).toBe(false)
  })
})
