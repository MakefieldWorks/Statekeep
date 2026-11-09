import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { ProjectManager } from '../../../src/main/project-manager'
import { GitService } from '../../../src/main/git-service'
import { HistoryOperationStore } from '../../../src/main/history-operation'
import { HistoryBackupStore } from '../../../src/main/history-backup'
import { PROJECT_DOCUMENT_FILE } from '../../../src/main/project-document-file'

const logger = { error() {}, warn() {}, info() {}, debug() {} }
let root: string
let path: string
let manager: ProjectManager
let git: GitService
let store: HistoryOperationStore
let historyPath: string
let backupPath: string
const recoveryName = 'recovery-unlisted.document.json'

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'statekeep-metadata-interruption-'))
  git = new GitService(logger as any)
  manager = new ProjectManager(git, logger as any)
  const created = await manager.createProject('Metadata Interruption', root)
  if (!created.ok) throw new Error(created.error.message)
  path = created.data.path!
  store = new HistoryOperationStore(path, created.data.id)
  historyPath = join(path, '.statekeep', 'history.json')
  backupPath = join(path, '.statekeep', 'history.backup.json')
  expect((await manager.snapshotCreate('baseline')).ok).toBe(true)
  mkdirSync(store.recoveryPath, { recursive: true })
  writeFileSync(join(store.recoveryPath, recoveryName), JSON.stringify(manager.getCurrent()))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await manager.waitForHistoryBackfill()
  manager.discardCurrentProject()
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function reopen() {
  manager.discardCurrentProject()
  manager = new ProjectManager(git, logger as any)
  const opened = await manager.openProject(path)
  if (!opened.ok) throw new Error(opened.error.message)
}

async function register() {
  const preview = await manager.recoveryFilesPreview()
  if (!preview.ok) throw new Error(preview.error.message)
  const result = await manager.adoptRecoveryFile({ token: preview.data.token, name: recoveryName })
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

function interruptCleanup() {
  return vi.spyOn(HistoryOperationStore.prototype, 'finish')
    .mockImplementation(() => { throw new Error('Injected interruption after metadata commit') })
}

describe('metadata-only history interruption protection', () => {
  it('rejects an invalid metadata intent before publishing a pending record', () => {
    const document = readFileSync(join(path, PROJECT_DOCUMENT_FILE))
    expect(() => store.beginMetadata('Restore without source', document.toString(), null, {
      kind: 'history-backup-restore', targetId: 'history.backup.json',
      expectedDocumentHash: createHash('sha256').update(document).digest('hex'),
      expectedHistoryHash: '0'.repeat(64),
    })).toThrow('No journal was published')
    expect(store.pending()).toBe(false)
  })

  it('recognizes a completed recovery registration and retains exact before-state bytes', async () => {
    const before = readFileSync(historyPath)
    const document = readFileSync(join(path, PROJECT_DOCUMENT_FILE))
    const interrupted = interruptCleanup()
    const point = await register()
    expect(store.pending()).toBe(true)
    const evidence = store.candidate()
    expect(evidence.record).toMatchObject({ version: 3, kind: 'recovery-register', targetId: point.id })
    expect(evidence.history).toEqual(before)
    expect(JSON.parse(evidence.inventory.toString()).id).toBe(manager.getCurrent()!.id)
    interrupted.mockRestore()

    await reopen()
    expect(store.pending()).toBe(false)
    expect(manager.interruptedHistoryStatus()).toMatchObject({ ok: true, data: { pending: false } })
    expect(readFileSync(join(path, PROJECT_DOCUMENT_FILE))).toEqual(document)
    expect(JSON.parse(readFileSync(historyPath, 'utf8')).recoveryPoints).toContainEqual(point)
    expect(store.retainedCandidates().candidates[0].record.kind).toBe('recovery-register')
  })

  it('recognizes a completed registration removal without deleting its payload', async () => {
    const point = await register()
    const before = readFileSync(historyPath)
    const payload = readFileSync(join(store.recoveryPath, recoveryName))
    const interrupted = interruptCleanup()
    expect((await manager.forgetRecoveryFile({ id: point.id })).ok).toBe(true)
    expect(store.candidate().history).toEqual(before)
    interrupted.mockRestore()

    await reopen()
    expect(store.pending()).toBe(false)
    expect(JSON.parse(readFileSync(historyPath, 'utf8')).recoveryPoints).not.toContainEqual(point)
    expect(readFileSync(join(store.recoveryPath, recoveryName))).toEqual(payload)
    expect(store.retainedCandidates().candidates[0].record.kind).toBe('recovery-forget')
  })

  it('does not auto-confirm a removal record while its target remains registered', async () => {
    const point = await register()
    const history = readFileSync(historyPath)
    const document = readFileSync(join(path, PROJECT_DOCUMENT_FILE))
    const { path: _path, ...project } = manager.getCurrent()!
    store.beginMetadata('Remove recovery registration', JSON.stringify(project), history, {
      kind: 'recovery-forget', targetId: point.id,
      expectedDocumentHash: createHash('sha256').update(document).digest('hex'),
      expectedHistoryHash: createHash('sha256').update(history).digest('hex'),
    })

    await reopen()
    expect(store.pending()).toBe(true)
    expect(manager.interruptedHistoryStatus()).toMatchObject({ ok: true, data: { pending: true } })
  })

  it('does not auto-confirm registration when its recovery payload changes', async () => {
    const interrupted = interruptCleanup()
    await register()
    writeFileSync(join(store.recoveryPath, recoveryName), '{}')
    interrupted.mockRestore()

    await reopen()
    expect(store.pending()).toBe(true)
    expect(manager.interruptedHistoryStatus()).toMatchObject({ ok: true, data: { pending: true } })
  })

  it('does not overwrite history changed after the operation reads its baseline', async () => {
    const point = await register()
    const save = HistoryBackupStore.prototype.save
    vi.spyOn(HistoryBackupStore.prototype, 'save').mockImplementation(function (history) {
      save.call(this, history)
      const changed = JSON.parse(readFileSync(historyPath, 'utf8'))
      changed.recoveryPoints.push({
        id: 'reconciled-outside-change', createdAt: new Date().toISOString(), reason: 'reconciled',
        payloadPath: `.statekeep/recovery/${recoveryName}`,
      })
      writeFileSync(historyPath, JSON.stringify(changed))
    })
    expect((await manager.forgetRecoveryFile({ id: point.id })).ok).toBe(false)
    expect(store.pending()).toBe(false)
    const history = JSON.parse(readFileSync(historyPath, 'utf8'))
    expect(history.recoveryPoints.map((entry: { id: string }) => entry.id)).toEqual([point.id, 'reconciled-outside-change'])
  })

  it('reports damaged history found after a recovery preview without publishing a journal', async () => {
    const save = HistoryBackupStore.prototype.save
    vi.spyOn(HistoryBackupStore.prototype, 'save').mockImplementation(function (history) {
      save.call(this, history)
      writeFileSync(historyPath, '{broken history')
    })
    const preview = await manager.recoveryFilesPreview()
    if (!preview.ok) throw new Error(preview.error.message)
    expect(await manager.adoptRecoveryFile({ token: preview.data.token, name: recoveryName })).toMatchObject({
      ok: false, error: { code: 'HISTORY_METADATA_UNAVAILABLE', message: expect.stringContaining('History metadata could not be read') },
    })
    expect(store.pending()).toBe(false)
  })

  it('journals the validated source bytes if the backup changes before restoration', async () => {
    writeFileSync(historyPath, '{broken history')
    const status = await manager.historyBackupStatus()
    if (!status.ok || !status.data.available) throw new Error(JSON.stringify(status))
    const source = readFileSync(backupPath)
    const candidate = HistoryBackupStore.prototype.candidate
    let calls = 0
    vi.spyOn(HistoryBackupStore.prototype, 'candidate').mockImplementation(function () {
      const result = candidate.call(this)
      if (++calls === 1) writeFileSync(backupPath, Buffer.concat([source, Buffer.from('\n')]))
      return result
    })
    expect(await manager.restoreHistoryBackup({ token: status.data.token }))
      .toMatchObject({ ok: false, error: { code: 'HISTORY_OPERATION_PENDING' } })
    expect(store.candidate().source).toEqual(source)
    expect(store.pending()).toBe(true)
  })

  it.each(['damaged', 'missing'] as const)('recognizes a completed backup restore from %s history', async original => {
    const before = original === 'damaged' ? Buffer.from([0xff, 0xfe, 0x00]) : null
    if (before) writeFileSync(historyPath, before)
    else rmSync(historyPath)
    const source = readFileSync(backupPath)
    const status = await manager.historyBackupStatus()
    if (!status.ok || !status.data.available) throw new Error(JSON.stringify(status))
    const interrupted = interruptCleanup()
    const restored = await manager.restoreHistoryBackup({ token: status.data.token })
    if (!restored.ok) throw new Error(restored.error.message)
    const evidence = store.candidate()
    expect(evidence.record).toMatchObject({ version: 3, kind: 'history-backup-restore', historyMissing: before === null })
    expect(evidence.history).toEqual(before ?? Buffer.alloc(0))
    expect(evidence.source).toEqual(source)
    if (before) expect(readFileSync(restored.data.preservedPath!)).toEqual(before)
    else expect(restored.data.preservedPath).toBeNull()
    interrupted.mockRestore()

    await reopen()
    expect(store.pending()).toBe(false)
    expect(JSON.parse(readFileSync(historyPath, 'utf8')).events).toHaveLength(1)
    const retained = manager.interruptedHistoryEvidencePreview()
    expect(retained).toMatchObject({ ok: true, data: { groups: [{ kind: 'history-backup-restore' }] } })
    if (retained.ok) expect(retained.data.groups[0].files).toHaveLength(4)
  })

  it('keeps an incomplete registration pending and continues without changing history or lineage', async () => {
    const before = readFileSync(historyPath)
    vi.spyOn(manager as any, 'writeSnapshotHistory').mockImplementation(() => { throw new Error('Injected write interruption') })
    const preview = await manager.recoveryFilesPreview()
    if (!preview.ok) throw new Error(preview.error.message)
    expect(await manager.adoptRecoveryFile({ token: preview.data.token, name: recoveryName }))
      .toMatchObject({ ok: false, error: { code: 'HISTORY_OPERATION_PENDING' } })
    expect(store.pending()).toBe(true)
    expect(store.candidate().history).toEqual(before)
    vi.restoreAllMocks()

    await reopen()
    expect(manager.interruptedHistoryStatus()).toMatchObject({ ok: true, data: { pending: true } })
    expect((await manager.saveProject()).ok).toBe(false)
    const review = manager.reviewInterruptedHistory()
    expect(review).toMatchObject({ ok: true, data: { metadataOnly: true } })
    if (!review.ok) return
    expect((await manager.acknowledgeInterruptedHistory({ token: review.data.token })).ok).toBe(true)
    expect(readFileSync(historyPath)).toEqual(before)
    expect(store.pending()).toBe(false)
    expect(JSON.parse(readFileSync(historyPath, 'utf8')).currentBaseSnapshotId).toBe('baseline')
  })

  it('keeps a failed backup restore pending with exact damaged and source bytes, then permits retry', async () => {
    const damaged = Buffer.from('{broken history')
    writeFileSync(historyPath, damaged)
    const source = readFileSync(backupPath)
    const status = await manager.historyBackupStatus()
    if (!status.ok || !status.data.available) throw new Error(JSON.stringify(status))
    vi.spyOn(HistoryBackupStore.prototype, 'restore').mockImplementation(() => { throw new Error('Injected restore interruption') })
    expect(await manager.restoreHistoryBackup({ token: status.data.token }))
      .toMatchObject({ ok: false, error: { code: 'HISTORY_OPERATION_PENDING' } })
    expect(store.candidate().history).toEqual(damaged)
    expect(store.candidate().source).toEqual(source)
    vi.restoreAllMocks()

    await reopen()
    expect(store.pending()).toBe(true)
    expect((await manager.restoreHistoryBackup({ token: status.data.token })).ok).toBe(false)
    const review = manager.reviewInterruptedHistory()
    expect(review).toMatchObject({ ok: true, data: { metadataOnly: true, currentHistoryAvailable: true } })
    if (!review.ok) return
    expect((await manager.acknowledgeInterruptedHistory({ token: review.data.token })).ok).toBe(true)
    expect(readFileSync(historyPath)).toEqual(damaged)
    expect(store.pending()).toBe(false)
    const retry = await manager.historyBackupStatus()
    if (!retry.ok || !retry.data.available) throw new Error(JSON.stringify(retry))
    expect((await manager.restoreHistoryBackup({ token: retry.data.token })).ok).toBe(true)
    expect(readdirSync(store.recoveryPath).some(name => name.endsWith('-operation.json'))).toBe(true)
  })

  it('does not auto-confirm a restore if preserved damaged bytes disagree', async () => {
    writeFileSync(historyPath, '{broken history')
    const status = await manager.historyBackupStatus()
    if (!status.ok || !status.data.available) throw new Error(JSON.stringify(status))
    const interrupted = interruptCleanup()
    const restored = await manager.restoreHistoryBackup({ token: status.data.token })
    if (!restored.ok || !restored.data.preservedPath) throw new Error(JSON.stringify(restored))
    writeFileSync(restored.data.preservedPath, 'changed outside Statekeep')
    interrupted.mockRestore()

    await reopen()
    expect(store.pending()).toBe(true)
    expect(manager.interruptedHistoryStatus()).toMatchObject({ ok: true, data: { pending: true } })
    expect((await manager.snapshotCreate('blocked')).ok).toBe(false)
    expect(existsSync(restored.data.preservedPath)).toBe(true)
  })

  it('lets an older pending snapshot record continue safely when current history is damaged', async () => {
    const document = readFileSync(join(path, PROJECT_DOCUMENT_FILE))
    const { path: _path, ...project } = manager.getCurrent()!
    store.begin('Create snapshot: interrupted', JSON.stringify(project), readFileSync(historyPath, 'utf8'), {
      kind: 'snapshot-create', eventId: '01993a75-1234-7000-8000-123456789abc', targetId: 'interrupted',
      expectedDocumentHash: createHash('sha256').update(document).digest('hex'),
    })
    const damaged = Buffer.from('{damaged after interruption')
    writeFileSync(historyPath, damaged)

    await reopen()
    expect(store.pending()).toBe(true)
    const review = manager.reviewInterruptedHistory()
    expect(review).toMatchObject({ ok: true, data: { metadataOnly: false, historyReadable: false } })
    if (!review.ok) return
    expect((await manager.acknowledgeInterruptedHistory({ token: review.data.token })).ok).toBe(true)
    expect(readFileSync(historyPath)).toEqual(damaged)
    expect(store.pending()).toBe(false)
    const retry = await manager.historyBackupStatus()
    if (!retry.ok || !retry.data.available) throw new Error(JSON.stringify(retry))
    expect((await manager.restoreHistoryBackup({ token: retry.data.token })).ok).toBe(true)
  })
})
