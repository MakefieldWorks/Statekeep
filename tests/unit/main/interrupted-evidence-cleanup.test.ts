import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ProjectManager } from '../../../src/main/project-manager'
import { GitService } from '../../../src/main/git-service'
import { HistoryOperationStore, RetainedEvidenceChangedError } from '../../../src/main/history-operation'

const logger = { error() {}, warn() {}, info() {}, debug() {} }
let root: string
let path: string
let historyPath: string
let recoveryPath: string
let manager: ProjectManager
let store: HistoryOperationStore

beforeEach(async () => {
  root = join(tmpdir(), `statekeep-evidence-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  manager = new ProjectManager(new GitService(logger as any), logger as any)
  const created = await manager.createProject('Evidence Cleanup', root)
  if (!created.ok) throw new Error(created.error.message)
  path = created.data.path!
  historyPath = join(path, '.statekeep', 'history.json')
  recoveryPath = join(path, '.statekeep', 'recovery')
  expect((await manager.snapshotCreate('baseline')).ok).toBe(true)
  store = new HistoryOperationStore(path, created.data.id)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await manager.waitForHistoryBackfill()
  manager.discardCurrentProject()
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function retainEvidence(label = 'Create snapshot: interrupted') {
  const { path: _path, ...project } = manager.getCurrent()!
  store.begin(label, JSON.stringify(project, null, 2), readFileSync(historyPath, 'utf8'))
  const record = store.candidate().record
  store.finish(true)
  return record
}

function evidencePaths(record: ReturnType<typeof retainEvidence>) {
  return [
    join(recoveryPath, `recovery-${record.id}-operation.json`),
    join(recoveryPath, record.inventoryFile),
    join(recoveryPath, record.historyFile),
  ]
}

describe('retained interrupted-operation evidence cleanup', () => {
  it('previews exact groups without writes and deletes only the selected evidence', () => {
    const record = retainEvidence()
    const paths = evidencePaths(record)
    const unknown = join(recoveryPath, 'keep-me.txt')
    writeFileSync(unknown, 'unrelated')
    const original = paths.map(file => readFileSync(file))

    const preview = manager.interruptedHistoryEvidencePreview()
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.data).toMatchObject({ unavailableCount: 0, uninspectedCount: 0, groups: [{
      id: record.id, label: 'Create snapshot: interrupted', beforeNodeCount: 1,
      currentNodeCount: 1, registeredAsRecoveryPoint: false,
    }] })
    expect(paths.map(file => readFileSync(file))).toEqual(original)
    const result = manager.deleteInterruptedHistoryEvidence({ id: record.id, token: preview.data.groups[0].token })
    expect(result).toMatchObject({ ok: true, data: { remainingFiles: [] } })
    expect(paths.every(file => !existsSync(file))).toBe(true)
    expect(readFileSync(unknown, 'utf8')).toBe('unrelated')
  })

  it.each(['missing', 'damaged'] as const)('keeps retained groups inspectable with %s current history but blocks deletion', condition => {
    const record = retainEvidence()
    const paths = evidencePaths(record)
    if (condition === 'missing') unlinkSync(historyPath)
    else writeFileSync(historyPath, '{broken history')

    const preview = manager.interruptedHistoryEvidencePreview()
    expect(preview).toMatchObject({ ok: true, data: { historyReadable: false, groups: [{ id: record.id }] } })
    if (!preview.ok) return
    expect(manager.deleteInterruptedHistoryEvidence({ id: record.id, token: preview.data.groups[0].token }))
      .toMatchObject({ ok: false, error: { code: 'HISTORY_METADATA_UNAVAILABLE' } })
    expect(paths.every(file => existsSync(file))).toBe(true)
  })

  it.each(['record', 'inventory', 'history-metadata'] as const)('rejects a stale preview after %s changes without deleting files', change => {
    const record = retainEvidence()
    const paths = evidencePaths(record)
    const preview = manager.interruptedHistoryEvidencePreview()
    if (!preview.ok) throw new Error(preview.error.message)
    if (change === 'record') {
      const value = JSON.parse(readFileSync(paths[0], 'utf8'))
      value.label = 'Changed label'
      writeFileSync(paths[0], JSON.stringify(value))
    } else if (change === 'inventory') {
      writeFileSync(paths[1], readFileSync(paths[1], 'utf8') + '\n')
    } else {
      writeFileSync(historyPath, readFileSync(historyPath, 'utf8') + '\n')
    }
    expect(manager.deleteInterruptedHistoryEvidence({ id: record.id, token: preview.data.groups[0].token }))
      .toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(paths.every(file => existsSync(file))).toBe(true)
  })

  it('blocks registered inventory until its recovery registration is explicitly removed', async () => {
    const record = retainEvidence()
    const files = await manager.recoveryFilesPreview()
    if (!files.ok) throw new Error(files.error.message)
    const name = record.inventoryFile
    const adopted = await manager.adoptRecoveryFile({ token: files.data.token, name })
    if (!adopted.ok) throw new Error(adopted.error.message)
    const blocked = manager.interruptedHistoryEvidencePreview()
    if (!blocked.ok) throw new Error(blocked.error.message)
    expect(blocked.data.groups[0].registeredAsRecoveryPoint).toBe(true)
    expect(manager.deleteInterruptedHistoryEvidence({ id: record.id, token: blocked.data.groups[0].token })).toMatchObject({
      ok: false, error: { code: 'VALIDATION_FAILED', message: expect.stringContaining('Additional recovery files') },
    })
    expect((await manager.forgetRecoveryFile({ id: adopted.data.id })).ok).toBe(true)
    const refreshed = manager.interruptedHistoryEvidencePreview()
    if (!refreshed.ok) throw new Error(refreshed.error.message)
    expect(manager.deleteInterruptedHistoryEvidence({ id: record.id, token: refreshed.data.groups[0].token }).ok).toBe(true)
  })

  it('leaves active, malformed, and unknown evidence untouched', () => {
    const record = retainEvidence()
    const recordPath = evidencePaths(record)[0]
    writeFileSync(recordPath, '{}')
    writeFileSync(join(recoveryPath, 'unknown-operation.json'), '{}')
    const preview = manager.interruptedHistoryEvidencePreview()
    expect(preview).toMatchObject({ ok: true, data: { groups: [], unavailableCount: 1 } })
    expect(existsSync(recordPath)).toBe(true)

    const { path: _path, ...project } = manager.getCurrent()!
    store.begin('Active operation', JSON.stringify(project), readFileSync(historyPath, 'utf8'))
    expect(manager.interruptedHistoryEvidencePreview()).toMatchObject({ ok: false, error: { code: 'HISTORY_OPERATION_PENDING' } })
    expect(manager.deleteInterruptedHistoryEvidence({ id: record.id, token: 'stale' })).toMatchObject({ ok: false, error: { code: 'HISTORY_OPERATION_PENDING' } })
    expect(store.pending()).toBe(true)
  })

  it('removes the record first and truthfully reports a payload that could not be deleted', () => {
    const record = retainEvidence()
    const candidate = store.retainedCandidates().candidates[0]
    let call = 0
    const result = store.removeRetained(candidate, file => {
      call++
      if (call >= 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      unlinkSync(file)
    })
    expect(result.deletedFiles).toEqual([candidate.recordFile, record.inventoryFile])
    expect(result.remainingFiles).toEqual([record.historyFile])
    expect(call).toBe(3)
    expect(existsSync(candidate.recordPath)).toBe(false)
    expect(existsSync(join(recoveryPath, record.inventoryFile))).toBe(false)
    expect(existsSync(join(recoveryPath, record.historyFile))).toBe(true)
  })

  it('reports a changed evidence group during final revalidation as a stale review', () => {
    const record = retainEvidence()
    const preview = manager.interruptedHistoryEvidencePreview()
    if (!preview.ok) throw new Error(preview.error.message)
    vi.spyOn(HistoryOperationStore.prototype, 'removeRetained').mockImplementation(() => {
      throw new RetainedEvidenceChangedError('Operation evidence changed. Review it again before deleting.')
    })
    expect(manager.deleteInterruptedHistoryEvidence({ id: record.id, token: preview.data.groups[0].token }))
      .toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(evidencePaths(record).every(file => existsSync(file))).toBe(true)
  })

  it('applies the inspection cap after ordering retained records by recency', () => {
    const older = retainEvidence('Older operation')
    const olderPath = evidencePaths(older)[0]
    utimesSync(olderPath, new Date(1_000), new Date(1_000))
    const newer = retainEvidence('Newer operation')
    const newerPath = evidencePaths(newer)[0]
    utimesSync(newerPath, new Date(2_000), new Date(2_000))
    const retained = store.retainedCandidates(1)
    expect(retained.candidates.map(candidate => candidate.record.id)).toEqual([newer.id])
    expect(retained.uninspectedCount).toBe(1)
  })
})
