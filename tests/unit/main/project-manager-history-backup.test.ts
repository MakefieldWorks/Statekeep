import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import * as fs from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProjectManager } from '../../../src/main/project-manager'
import { GitService } from '../../../src/main/git-service'
import { HistoryBackupStore } from '../../../src/main/history-backup'
import { PROJECT_DOCUMENT_FILE } from '../../../src/main/project-document-file'

// Keep real filesystem behavior while allowing one targeted failure injection.
vi.mock('fs', async importOriginal => ({ ...await importOriginal<typeof import('fs')>() }))

const logger = { error() {}, warn() {}, info() {}, debug() {} }
let directory: string
let projectPath: string
let manager: ProjectManager
let git: GitService
let historyPath: string
let backupPath: string

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'statekeep-history-backup-'))
  git = new GitService(logger as any)
  manager = new ProjectManager(git, logger as any)
  const result = await manager.createProject('History Backup Lab', directory)
  if (!result.ok) throw new Error(result.error.message)
  projectPath = result.data.path!
  historyPath = join(projectPath, '.statekeep', 'history.json')
  backupPath = join(projectPath, '.statekeep', 'history.backup.json')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await manager.waitForHistoryBackfill()
  await manager.flushAndClose()
  manager.discardCurrentProject()
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function preview() {
  const status = await manager.historyBackupStatus()
  if (!status.ok || !status.data.available) throw new Error(JSON.stringify(status))
  return status.data
}

describe('automatic history backup and explicit restore', () => {
  it('backs up the latest successful metadata and restores it without changing current inventory or undo', async () => {
    await manager.snapshotCreate('baseline', 'Known-good lab')
    const root = manager.getCurrent()!.nodes[0].id
    manager.nodeCreate(root, 'Pre-revert rack')
    const reverted = await manager.snapshotRevert({ name: 'baseline' })
    if (!reverted.ok) throw new Error(reverted.error.message)
    const point = reverted.data.safetyRecoveryPoint!
    const history = JSON.parse(readFileSync(historyPath, 'utf8'))
    expect(JSON.parse(readFileSync(backupPath, 'utf8')).history).toEqual(history)
    manager.nodeCreate(root, 'Current unsnapshotted rack')
    await manager.saveProject()
    const current = structuredClone(manager.getCurrent())
    const document = readFileSync(join(projectPath, PROJECT_DOCUMENT_FILE), 'utf8')
    const edits = manager.editHistoryState()
    const tags = await git.listSnapshots(projectPath)
    const damaged = Buffer.from([0xff, 0xfe, 0x7b, 0x00])
    writeFileSync(historyPath, damaged)
    const status = await preview()
    expect(status).toMatchObject({ snapshotCount: 1, eventCount: 2, recoveryPointCount: 1 })
    const result = await manager.restoreHistoryBackup({ token: status.token })
    if (!result.ok) throw new Error(result.error.message)
    expect(readFileSync(result.data.preservedPath!)).toEqual(damaged)
    expect(manager.getCurrent()).toEqual(current)
    expect(readFileSync(join(projectPath, PROJECT_DOCUMENT_FILE), 'utf8')).toBe(document)
    expect(manager.editHistoryState()).toEqual(edits)
    expect(await git.listSnapshots(projectPath)).toEqual(tags)
    const restored = JSON.parse(readFileSync(historyPath, 'utf8'))
    expect(restored).toEqual({ ...history, currentBaseSnapshotId: null, pendingRevertEventId: null })
    expect(JSON.parse(readFileSync(backupPath, 'utf8')).history).toEqual(history)
    expect((await manager.snapshotTimeline()).ok).toBe(true)
    expect((await manager.recoveryPointApply({ id: point.id })).ok).toBe(true)
  })

  it.each(['primary', 'backup'])('rejects a stale preview after the %s changes', async target => {
    await manager.snapshotCreate('baseline')
    writeFileSync(historyPath, '{damaged')
    const status = await preview()
    if (target === 'primary') writeFileSync(historyPath, '{different damage')
    else writeFileSync(backupPath, readFileSync(backupPath, 'utf8') + '\n')
    const bytes = readFileSync(historyPath)
    expect(await manager.restoreHistoryBackup({ token: status.token }))
      .toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(readFileSync(historyPath)).toEqual(bytes)
    expect(readdirSync(join(projectPath, '.statekeep')).filter(name => name.includes('.damaged-'))).toEqual([])
  })

  it.each(['missing', 'corrupt', 'foreign', 'future backup', 'missing snapshot', 'future primary', 'healthy primary'])('refuses unsafe restore: %s', async fault => {
    await manager.snapshotCreate('baseline')
    const valid = readFileSync(historyPath, 'utf8')
    writeFileSync(historyPath, '{damaged')
    const backup = JSON.parse(readFileSync(backupPath, 'utf8'))
    if (fault === 'missing') rmSync(backupPath)
    if (fault === 'corrupt') writeFileSync(backupPath, '{damaged backup')
    if (fault === 'future backup') writeFileSync(backupPath, JSON.stringify({ ...backup, version: 999 }))
    if (fault === 'foreign') {
      backup.projectId = 'another-project'
      writeFileSync(backupPath, JSON.stringify(backup))
    }
    if (fault === 'missing snapshot') {
      backup.history.events.push({ id: 'missing-event', type: 'snapshot', snapshotId: 'missing', createdAt: new Date().toISOString() })
      writeFileSync(backupPath, JSON.stringify(backup))
    }
    if (fault === 'future primary') writeFileSync(historyPath, JSON.stringify({ version: 999 }))
    if (fault === 'healthy primary') writeFileSync(historyPath, valid)
    const bytes = readFileSync(historyPath)
    expect(await manager.historyBackupStatus()).toMatchObject({ ok: true, data: { available: false } })
    expect((await manager.restoreHistoryBackup({ token: 'not-a-valid-preview' })).ok).toBe(false)
    expect(readFileSync(historyPath)).toEqual(bytes)
  })

  it('refuses a backup with a missing recovery payload', async () => {
    await manager.snapshotCreate('baseline')
    manager.nodeCreate(manager.getCurrent()!.nodes[0].id, 'Recoverable rack')
    const result = await manager.snapshotRevert({ name: 'baseline' })
    if (!result.ok) throw new Error(result.error.message)
    rmSync(join(projectPath, result.data.safetyRecoveryPoint!.payloadPath))
    writeFileSync(historyPath, '{damaged')
    expect(await manager.historyBackupStatus()).toMatchObject({ ok: true, data: { available: false } })
  })

  it('protects and restores the backup when the primary metadata was deleted', async () => {
    await manager.snapshotCreate('baseline', 'Must survive deletion')
    const backup = readFileSync(backupPath)
    rmSync(historyPath)
    expect(await manager.snapshotCreate('blocked')).toMatchObject({ ok: false, error: { code: 'HISTORY_METADATA_UNAVAILABLE' } })
    expect(readFileSync(backupPath)).toEqual(backup)
    const status = await preview()
    expect(status.originalMissing).toBe(true)
    const result = await manager.restoreHistoryBackup({ token: status.token })
    expect(result).toEqual({ ok: true, data: { preservedPath: null } })
    const list = await manager.snapshotList()
    if (!list.ok) throw new Error(list.error.message)
    expect(list.data[0].note).toBe('Must survive deletion')
  })

  it('shows backup lag, restores newer tags after older events, and retains unlisted recovery files', async () => {
    await manager.snapshotCreate('baseline', 'Original context')
    const backup = readFileSync(backupPath)
    manager.nodeCreate(manager.getCurrent()!.nodes[0].id, 'New rack')
    await manager.snapshotCreate('later')
    const reverted = await manager.snapshotRevert({ name: 'baseline', note: 'Rollback later work' })
    if (!reverted.ok) throw new Error(reverted.error.message)
    // Ensure an unlisted payload exists independently of whether HEAD matched.
    mkdirSync(join(projectPath, '.statekeep', 'recovery'), { recursive: true })
    const orphan = join(projectPath, '.statekeep', 'recovery', 'unlisted.document.json')
    writeFileSync(orphan, JSON.stringify(manager.getCurrent()))
    writeFileSync(backupPath, backup)
    writeFileSync(historyPath, '{damaged')
    const status = await preview()
    expect(status.missingSnapshots).toEqual(['later'])
    expect(status.unlistedRecoveryFiles).toContain('unlisted.document.json')
    expect((await manager.restoreHistoryBackup({ token: status.token })).ok).toBe(true)
    const timeline = await manager.snapshotTimeline()
    if (!timeline.ok) throw new Error(timeline.error.message)
    expect(timeline.data.events.map(event => event.snapshotId)).toEqual(['baseline', 'later'])
    expect(await manager.snapshotRevert({ name: 'baseline' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(existsSync(orphan)).toBe(true)
  })

  it('rechecks referenced files when restoring a preview', async () => {
    await manager.snapshotCreate('baseline')
    mkdirSync(join(projectPath, '.statekeep', 'recovery'), { recursive: true })
    writeFileSync(historyPath, '{damaged')
    const status = await preview()
    writeFileSync(join(projectPath, '.statekeep', 'recovery', 'new.document.json'), '{}')
    expect(await manager.restoreHistoryBackup({ token: status.token })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })

  it('keeps separate byte-identical originals across repeated restores', async () => {
    await manager.snapshotCreate('baseline')
    const paths: string[] = []
    for (const damaged of ['{first damage', '{second damage']) {
      writeFileSync(historyPath, damaged)
      const status = await preview()
      const restored = await manager.restoreHistoryBackup({ token: status.token })
      if (!restored.ok) throw new Error(restored.error.message)
      paths.push(restored.data.preservedPath!)
      expect(readFileSync(restored.data.preservedPath!, 'utf8')).toBe(damaged)
    }
    expect(paths[0]).not.toBe(paths[1])
    expect(readFileSync(paths[0], 'utf8')).toBe('{first damage')
  })

  it('leaves the primary and backup untouched if preserving the damaged original fails', async () => {
    await manager.snapshotCreate('baseline')
    const damaged = '{do not lose these bytes'
    writeFileSync(historyPath, damaged)
    const backup = readFileSync(backupPath)
    const status = await preview()
    const open = fs.openSync
    vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]).includes('.damaged-')) throw new Error('injected preservation failure')
      return open(...args)
    })
    expect((await manager.restoreHistoryBackup({ token: status.token })).ok).toBe(false)
    expect(readFileSync(historyPath, 'utf8')).toBe(damaged)
    expect(readFileSync(backupPath)).toEqual(backup)
  })

  it('offers a retry when the project changes during backup preview', async () => {
    await manager.snapshotCreate('baseline')
    writeFileSync(historyPath, '{damaged')
    const snapshots = await git.listSnapshots(projectPath)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(git, 'listSnapshots').mockImplementation(async () => { await gate; return snapshots })
    const pending = manager.historyBackupStatus()
    await manager.flushAndClose()
    release()
    expect(await pending).toMatchObject({ ok: false, error: {
      code: 'VALIDATION_FAILED', message: expect.stringContaining('Try reviewing the backup again'),
    } })
  })

  it('explains when no automatic backup has been saved', async () => {
    await manager.snapshotCreate('baseline')
    writeFileSync(historyPath, '{damaged')
    rmSync(backupPath)
    expect(await manager.historyBackupStatus()).toMatchObject({ ok: true, data: {
      available: false, reason: expect.stringContaining('No automatic history backup has been saved'),
    } })
  })

  it('excludes competing history operations while restore is validating', async () => {
    await manager.snapshotCreate('baseline')
    writeFileSync(historyPath, '{damaged')
    const status = await preview()
    const list = git.listSnapshots.bind(git)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(git, 'listSnapshots').mockImplementation(async path => { await gate; return list(path) })
    const restoring = manager.restoreHistoryBackup({ token: status.token })
    expect(await manager.snapshotCreate('blocked')).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await manager.restoreHistoryBackup({ token: status.token })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    release()
    expect((await restoring).ok).toBe(true)
  })

  it('fails before a snapshot changes anything when the backup cannot be written', async () => {
    await manager.snapshotCreate('baseline')
    const bytes = readFileSync(historyPath)
    rmSync(backupPath)
    mkdirSync(backupPath)
    expect(await manager.snapshotCreate('blocked'))
      .toMatchObject({ ok: false, error: { code: 'HISTORY_BACKUP_FAILED' } })
    expect((await git.listSnapshots(projectPath)).map(snapshot => snapshot.name)).toEqual(['baseline'])
    expect(readFileSync(historyPath)).toEqual(bytes)
    expect(readdirSync(join(projectPath, '.statekeep')).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('retains the previous backup and its payloads if backup refresh fails after primary commit', async () => {
    await manager.snapshotCreate('baseline')
    const root = manager.getCurrent()!.nodes[0].id
    const payloads: string[] = []
    for (let i = 0; i < 10; i++) {
      manager.nodeCreate(root, `Rack ${i}`)
      const reverted = await manager.snapshotRevert({ name: 'baseline' })
      if (!reverted.ok) throw new Error(reverted.error.message)
      payloads.push(reverted.data.safetyRecoveryPoint!.payloadPath)
    }
    const originalSave = HistoryBackupStore.prototype.save
    let calls = 0
    vi.spyOn(HistoryBackupStore.prototype, 'save').mockImplementation(function (history) {
      if (++calls === 2) throw new Error('injected backup refresh failure')
      originalSave.call(this, history)
    })
    manager.nodeCreate(root, 'Newest rack')
    expect((await manager.snapshotRevert({ name: 'baseline' })).ok).toBe(true)
    expect(existsSync(join(projectPath, payloads[0]))).toBe(true)
    const primary = JSON.parse(readFileSync(historyPath, 'utf8'))
    const backup = JSON.parse(readFileSync(backupPath, 'utf8'))
    expect(primary.recoveryPoints[0].payloadPath).not.toBe(payloads[0])
    expect(backup.history.recoveryPoints[0].payloadPath).toBe(payloads[0])
    writeFileSync(historyPath, '{damaged after backup failure')
    expect((await preview()).recoveryPointCount).toBe(10)
  })
})
