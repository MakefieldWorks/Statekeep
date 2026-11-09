import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { ProjectManager } from '../../../src/main/project-manager'
import { GitService } from '../../../src/main/git-service'
import { HistoryIndexService } from '../../../src/main/history-index'
import { SearchIndexService } from '../../../src/main/search-index'
import { CURRENT_PROJECT_REF } from '../../../src/shared/snapshot-ref'
import { PROJECT_DOCUMENT_FILE } from '../../../src/main/project-document-file'

const noopLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
}

let tmpDir: string
let git: GitService
let manager: ProjectManager
let projectDir: string

beforeEach(async () => {
  tmpDir = join(tmpdir(), `statekeep-snapshots-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })

  git = new GitService(noopLogger as any)
  manager = new ProjectManager(git, noopLogger as any)

  const created = await manager.createProject('Snapshot Project', tmpDir)
  expect(created.ok).toBe(true)
  if (!created.ok) throw new Error(created.error.message)

  projectDir = created.data.path!
})

afterEach(async () => {
  manager.cancelAutosave()
  await manager.flushAndClose()
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

describe('snapshot workflow', () => {
  it('creates and lists named snapshots in the git-backed project', async () => {
    manager.nodeCreate(manager.getCurrent()!.nodes[0].id, 'Rack A')
    const created = await manager.snapshotCreate('initial-setup', '  Known-good rack configuration.  ')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.name).toBe('initial-setup')
    expect(created.data.note).toBe('Known-good rack configuration.')

    const listed = await manager.snapshotList()
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.data.some((snapshot) => snapshot.name === 'initial-setup')).toBe(true)
    expect(listed.data.find((snapshot) => snapshot.name === 'initial-setup')?.message).toBe('initial-setup')
    expect(listed.data.find((snapshot) => snapshot.name === 'initial-setup')?.note).toBe('Known-good rack configuration.')

    const timeline = await manager.snapshotTimeline()
    expect(timeline.ok).toBe(true)
    if (!timeline.ok) return
    expect(timeline.data.events.find((event) => event.snapshotId === 'initial-setup')?.note)
      .toBe('Known-good rack configuration.')

    const history = JSON.parse(readFileSync(join(projectDir, '.statekeep', 'history.json'), 'utf8'))
    expect(history.snapshots['initial-setup'].note).toBe('Known-good rack configuration.')
  })

  it('rejects invalid snapshot descriptions before creating a snapshot', async () => {
    const nonText = await manager.snapshotCreate('invalid-description', { text: 'nope' })
    expect(nonText.ok).toBe(false)
    if (!nonText.ok) expect(nonText.error.code).toBe('VALIDATION_FAILED')

    const tooLong = await manager.snapshotCreate('description-too-long', 'x'.repeat(2001))
    expect(tooLong.ok).toBe(false)
    if (!tooLong.ok) expect(tooLong.error.message).toContain('2,000')

    const listed = await manager.snapshotList()
    expect(listed.ok).toBe(true)
    if (listed.ok) expect(listed.data).toEqual([])
  })

  it('rejects duplicate snapshot names', async () => {
    const first = await manager.snapshotCreate('duplicate-name')
    expect(first.ok).toBe(true)

    const second = await manager.snapshotCreate('duplicate-name')
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.error.code).toBe('VALIDATION_FAILED')
  })

  it('carries snapshot metadata into timeline events synthesized for missing event records', async () => {
    const created = await manager.snapshotCreate('metadata-only', 'Retained historical context')
    expect(created.ok).toBe(true)

    const historyPath = join(projectDir, '.statekeep', 'history.json')
    const history = JSON.parse(readFileSync(historyPath, 'utf8'))
    history.events = []
    writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf8')

    const timeline = await manager.snapshotTimeline()
    expect(timeline.ok).toBe(true)
    if (!timeline.ok) return
    expect(timeline.data.events).toHaveLength(1)
    expect(timeline.data.events[0].note).toBe('Retained historical context')
  })

  it('compares two snapshots with semantic diffs', async () => {
    const rootId = manager.getCurrent()!.nodes.find((node) => node.parentId === null)!.id
    manager.nodeCreate(rootId, 'Rack A')
    const rackA = manager.getCurrent()!.nodes.find((node) => node.name === 'Rack A')!
    await manager.snapshotCreate('before-changes')

    manager.nodeUpdate(rackA.id, { name: 'Rack Alpha', properties: { serial: 'SN-100' } })
    const rootChildren = manager.getCurrent()!.nodes.filter((node) => node.parentId === rootId)
    const renamedRack = rootChildren.find((node) => node.id === rackA.id)!
    manager.nodeCreate(rootId, 'Rack B')
    const rackB = manager.getCurrent()!.nodes.find((node) => node.name === 'Rack B')!
    manager.nodeMove(renamedRack.id, rackB.id, 999)
    await manager.snapshotCreate('after-changes')

    const compared = await manager.snapshotCompare('before-changes', 'after-changes')
    expect(compared.ok).toBe(true)
    if (!compared.ok) return
    expect(compared.data.map((diff) => diff.changeType)).toEqual([
      'added',
      'moved',
      'renamed',
      'property-changed',
    ])
  })

  it('limits compare and reports to a selected subtree', async () => {
    const rootId = manager.getCurrent()!.nodes.find(node => node.parentId === null)!.id
    manager.nodeCreate(rootId, 'Rack A')
    manager.nodeCreate(rootId, 'Rack B')
    const rackA = manager.getCurrent()!.nodes.find(node => node.name === 'Rack A')!
    const rackB = manager.getCurrent()!.nodes.find(node => node.name === 'Rack B')!
    manager.nodeCreate(rackA.id, 'Server A')
    manager.nodeCreate(rackB.id, 'Server B')
    const serverA = manager.getCurrent()!.nodes.find(node => node.name === 'Server A')!
    const serverB = manager.getCurrent()!.nodes.find(node => node.name === 'Server B')!
    await manager.snapshotCreate('scope-before')

    manager.nodeUpdate(serverA.id, { properties: { firmware: '2.0.0' } })
    manager.nodeUpdate(serverB.id, { properties: { firmware: '9.0.0' } })
    await manager.snapshotCreate('scope-after')

    const compared = await manager.snapshotLoadCompare('scope-before', 'scope-after', rackA.id)
    expect(compared.ok).toBe(true)
    if (!compared.ok) return
    expect(compared.data.scope).toEqual({
      nodeId: rackA.id,
      name: 'Rack A',
      path: 'Snapshot Project / Rack A',
    })
    expect(compared.data.nodes.flatMap(node => node.diffs).map(diff => diff.nodeId))
      .toEqual([serverA.id])

    const report = await manager.buildReport('scope-before', 'scope-after', 'markdown', rackA.id)
    expect(report.ok).toBe(true)
    if (!report.ok) return
    expect(report.data.content).toContain('**Scope:** Snapshot Project / Rack A')
    expect(report.data.content).toContain('Server A')
    expect(report.data.content).not.toContain('Server B')
    expect(report.data.suggestedName).toContain(`-Rack_A-${rackA.id}.md`)

    const invalid = await manager.snapshotLoadCompare('scope-before', 'scope-after', 'missing-node')
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.code).toBe('VALIDATION_FAILED')

    const malformed = await manager.snapshotCompare('scope-before', 'scope-after', { nodeId: rackA.id })
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) expect(malformed.error.code).toBe('VALIDATION_FAILED')
  })

  it('compares a snapshot to the live current project (unsnapshotted changes)', async () => {
    const rootId = manager.getCurrent()!.nodes.find((node) => node.parentId === null)!.id
    manager.nodeCreate(rootId, 'Rack A')
    const rackA = manager.getCurrent()!.nodes.find((node) => node.name === 'Rack A')!
    await manager.snapshotCreate('baseline')

    // Edit AFTER the snapshot — these changes exist only in the current project.
    manager.nodeUpdate(rackA.id, { name: 'Rack Alpha' })
    manager.nodeCreate(rootId, 'Rack B')

    const compared = await manager.snapshotCompare('baseline', CURRENT_PROJECT_REF)
    expect(compared.ok).toBe(true)
    if (!compared.ok) return
    expect(compared.data.map((diff) => diff.changeType).sort()).toEqual(['added', 'renamed'])

    // The merged tree reflects the live edits and labels the current side.
    const merged = await manager.snapshotLoadCompare('baseline', CURRENT_PROJECT_REF)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    expect(merged.data.fromSnapshot).toBe('baseline')
    expect(merged.data.toSnapshot).toBe(CURRENT_PROJECT_REF)
    expect(merged.data.summary.added).toBe(1)
    expect(merged.data.summary.renamed).toBe(1)
  })

  it('compares the live current project as the FROM side (direction inverts)', async () => {
    const rootId = manager.getCurrent()!.nodes.find((node) => node.parentId === null)!.id
    manager.nodeCreate(rootId, 'Rack A')
    await manager.snapshotCreate('baseline')
    // Rack B exists only in the current project (added after the snapshot).
    manager.nodeCreate(rootId, 'Rack B')

    // current = FROM, snapshot = TO: a node present in current but absent in the
    // snapshot is a removal in this direction (the inverse of the to-side case).
    const compared = await manager.snapshotCompare(CURRENT_PROJECT_REF, 'baseline')
    expect(compared.ok).toBe(true)
    if (!compared.ok) return
    expect(compared.data.map((diff) => diff.changeType)).toContain('removed')
  })

  it('builds a diff report labeling the current-project side (either direction)', async () => {
    const rootId = manager.getCurrent()!.nodes.find((node) => node.parentId === null)!.id
    manager.nodeCreate(rootId, 'Rack A')
    await manager.snapshotCreate('baseline')
    manager.nodeCreate(rootId, 'Rack B')

    const toReport = await manager.buildReport('baseline', CURRENT_PROJECT_REF, 'markdown')
    expect(toReport.ok).toBe(true)
    if (!toReport.ok) return
    expect(toReport.data.content).toContain('Current project')
    expect(toReport.data.content).toContain('Rack B')

    // Current as FROM: the blank date/hash must not render as "undefined"/"NaN".
    const fromReport = await manager.buildReport(CURRENT_PROJECT_REF, 'baseline', 'markdown')
    expect(fromReport.ok).toBe(true)
    if (!fromReport.ok) return
    expect(fromReport.data.content).toContain('Current project')
    expect(fromReport.data.content).not.toMatch(/undefined|NaN/)
    // The suggested filename uses a clear token, not bare "current" (which reads
    // like an ordinary snapshot named "current").
    expect(toReport.data.suggestedName).toContain('current-project')
    expect(toReport.data.suggestedName).not.toContain('@')
  })

  it('treats comparing a ref against itself as an empty diff (no redundant read)', async () => {
    const rootId = manager.getCurrent()!.nodes.find((node) => node.parentId === null)!.id
    manager.nodeCreate(rootId, 'Rack A')
    await manager.snapshotCreate('baseline')

    // Self-compare is a no-op by definition; the guard short-circuits it.
    const selfCurrent = await manager.snapshotCompare(CURRENT_PROJECT_REF, CURRENT_PROJECT_REF)
    expect(selfCurrent.ok).toBe(true)
    if (selfCurrent.ok) expect(selfCurrent.data).toEqual([])

    const selfSnapshot = await manager.snapshotCompare('baseline', 'baseline')
    expect(selfSnapshot.ok).toBe(true)
    if (selfSnapshot.ok) expect(selfSnapshot.data).toEqual([])
  })

  it('reports snapshot read failures distinctly from commit failures', async () => {
    const rootId = manager.getCurrent()!.nodes.find((node) => node.parentId === null)!.id
    manager.nodeCreate(rootId, 'Rack A')
    await manager.snapshotCreate('baseline')

    const originalRead = git.readSnapshotDocument.bind(git)
    ;(git as any).readSnapshotDocument = async () => {
      throw new Error('snapshot tag not found')
    }

    try {
      const compared = await manager.snapshotCompare('baseline', 'missing')
      expect(compared.ok).toBe(false)
      if (!compared.ok) {
        expect(compared.error.code).toBe('SNAPSHOT_READ_FAILED')
        expect(compared.error.message).toContain('Failed to compare snapshots')
      }

      const loaded = await manager.snapshotLoadCompare('baseline', 'missing')
      expect(loaded.ok).toBe(false)
      if (!loaded.ok) {
        expect(loaded.error.code).toBe('SNAPSHOT_READ_FAILED')
        expect(loaded.error.message).toContain('Failed to load compare')
      }
    } finally {
      ;(git as any).readSnapshotDocument = originalRead
    }
  })

  it('reverts a previous snapshot onto disk and into current project state', async () => {
    const rootId = manager.getCurrent()!.nodes.find((node) => node.parentId === null)!.id
    manager.nodeCreate(rootId, 'Rack A')
    await manager.snapshotCreate('baseline')

    const rack = manager.getCurrent()!.nodes.find((node) => node.name === 'Rack A')!
    manager.nodeUpdate(rack.id, { name: 'Rack Alpha', properties: { serial: 'SN-42' } })

    const reverted = await manager.snapshotRevert({ name: 'baseline' })
    expect(reverted.ok).toBe(true)
    if (!reverted.ok) return
    expect(reverted.data.event.type).toBe('revert')
    expect(reverted.data.event.targetSnapshotId).toBe('baseline')
    expect(reverted.data.safetyRecoveryPoint).not.toBeNull()
    expect(existsSync(join(projectDir, reverted.data.safetyRecoveryPoint!.payloadPath))).toBe(true)
    const timeline = await manager.snapshotTimeline()
    expect(timeline.ok).toBe(true)
    if (!timeline.ok) return
    expect(timeline.data.events.some((event) => event.id === reverted.data.event.id)).toBe(true)
    expect(timeline.data.recoveryPoints.some((point) => point.id === reverted.data.safetyRecoveryPoint!.id)).toBe(true)

    expect(manager.getCurrent()!.nodes.some((node) => node.name === 'Rack A')).toBe(true)
    expect(manager.getCurrent()!.nodes.some((node) => node.name === 'Rack Alpha')).toBe(false)

    const recovered = await manager.recoveryPointApply({ id: reverted.data.safetyRecoveryPoint!.id })
    expect(recovered.ok).toBe(true)
    if (!recovered.ok) return
    expect(recovered.data.event.type).toBe('recover')
    expect(recovered.data.event.recoveryPointId).toBe(reverted.data.safetyRecoveryPoint!.id)

    const current = manager.getCurrent()!
    expect(current.nodes.some((node) => node.name === 'Rack Alpha')).toBe(true)

    const document = JSON.parse(readFileSync(join(projectDir, 'Statekeep.statekeep'), 'utf8'))
    expect(document.nodes.some((node: { name: string }) => node.name === 'Rack Alpha')).toBe(true)
  })

  it('requires a note when reverting past later snapshots and records lineage on the next snapshot', async () => {
    const rootId = manager.getCurrent()!.nodes.find((node) => node.parentId === null)!.id
    manager.nodeCreate(rootId, 'Rack A')
    const baseline = await manager.snapshotCreate('baseline')
    expect(baseline.ok).toBe(true)

    const rack = manager.getCurrent()!.nodes.find((node) => node.name === 'Rack A')!
    manager.nodeUpdate(rack.id, { name: 'Rack Alpha' })
    const upgraded = await manager.snapshotCreate('upgraded')
    expect(upgraded.ok).toBe(true)

    const missingNote = await manager.snapshotRevert({ name: 'baseline' })
    expect(missingNote.ok).toBe(false)
    if (!missingNote.ok) {
      expect(missingNote.error.code).toBe('VALIDATION_FAILED')
    }

    const reverted = await manager.snapshotRevert({
      name: 'baseline',
      note: 'Rolled back from upgraded to retry failed test',
    })
    expect(reverted.ok).toBe(true)
    if (!reverted.ok) return
    expect(reverted.data.event.note).toBe('Rolled back from upgraded to retry failed test')
    expect(reverted.data.safetyRecoveryPoint).toBeNull()

    const currentRack = manager.getCurrent()!.nodes.find((node) => node.name === 'Rack A')!
    manager.nodeUpdate(currentRack.id, { properties: { firmware: '2.0.1-alt' } })
    const alternate = await manager.snapshotCreate('alternate')
    expect(alternate.ok).toBe(true)
    if (!alternate.ok) return
    expect(alternate.data.basedOnSnapshotId).toBe('baseline')
    expect(alternate.data.createdAfterRevertEventId).toBe(reverted.data.event.id)

    const listed = await manager.snapshotList()
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    const alternateListed = listed.data.find((snapshot) => snapshot.name === 'alternate')
    expect(alternateListed?.basedOnSnapshotId).toBe('baseline')
    expect(alternateListed?.createdAfterRevertEventId).toBe(reverted.data.event.id)

    const timeline = await manager.snapshotTimeline()
    expect(timeline.ok).toBe(true)
    if (!timeline.ok) return
    expect(timeline.data.events.map((event) => event.type)).toEqual([
      'snapshot',
      'snapshot',
      'revert',
      'snapshot',
    ])
    expect(timeline.data.events.find((event) => event.type === 'revert')?.note)
      .toBe('Rolled back from upgraded to retry failed test')
  })

  it('caps stored recovery points, deletes the oldest files, and retains an applied source', async () => {
    const rootId = manager.getCurrent()!.nodes.find((node) => node.parentId === null)!.id
    const baseline = await manager.snapshotCreate('baseline')
    expect(baseline.ok).toBe(true)

    // 12 revert cycles, each preceded by an unsnapshotted edit so a recovery
    // point is created. With MAX_RECOVERY_POINTS = 10, the two oldest must be
    // pruned from history.json AND deleted from disk.
    const recoveryFiles: string[] = []
    for (let i = 0; i < 12; i++) {
      const created = manager.nodeCreate(rootId, `Probe ${i}`)
      expect(created.ok).toBe(true)
      const reverted = await manager.snapshotRevert({ name: 'baseline' })
      expect(reverted.ok).toBe(true)
      if (!reverted.ok) return
      expect(reverted.data.safetyRecoveryPoint).not.toBeNull()
      recoveryFiles.push(reverted.data.safetyRecoveryPoint!.payloadPath)
    }

    const timeline = await manager.snapshotTimeline()
    expect(timeline.ok).toBe(true)
    if (!timeline.ok) return
    expect(timeline.data.recoveryPoints.length).toBe(10)

    // The two oldest recovery files should have been deleted; the newest 10 remain.
    expect(existsSync(join(projectDir, recoveryFiles[0]))).toBe(false)
    expect(existsSync(join(projectDir, recoveryFiles[1]))).toBe(false)
    for (let i = 2; i < 12; i++) {
      expect(existsSync(join(projectDir, recoveryFiles[i]))).toBe(true)
    }

    // Applying the oldest retained point creates another safety point. Keep
    // the applied source available for interruption proof and prune the next
    // oldest point instead.
    const appliedId = timeline.data.recoveryPoints[0].id
    expect(manager.nodeCreate(rootId, 'Unsaved before recovery').ok).toBe(true)
    expect((await manager.recoveryPointApply({ id: appliedId })).ok).toBe(true)
    const afterApply = await manager.snapshotTimeline()
    expect(afterApply.ok).toBe(true)
    if (!afterApply.ok) return
    expect(afterApply.data.recoveryPoints).toHaveLength(10)
    expect(afterApply.data.recoveryPoints.some(point => point.id === appliedId)).toBe(true)
    expect(existsSync(join(projectDir, recoveryFiles[2]))).toBe(true)
    expect(existsSync(join(projectDir, recoveryFiles[3]))).toBe(false)
  })

  it('keeps the current project editable after reopening with damaged metadata', async () => {
    expect((await manager.snapshotCreate('baseline')).ok).toBe(true)
    await manager.flushAndClose()
    const historyPath = join(projectDir, '.statekeep', 'history.json')
    const damaged = '{damaged on disk'
    writeFileSync(historyPath, damaged)
    expect((await manager.openProject(projectDir)).ok).toBe(true)
    await manager.waitForHistoryBackfill()
    expect(manager.getHistoryBackfillStatus().inProgress).toBe(false)
    expect(await manager.nodeHistory(manager.getCurrent()!.nodes[0].id))
      .toMatchObject({ ok: false, error: { code: 'HISTORY_METADATA_UNAVAILABLE' } })
    expect(manager.nodeCreate(manager.getCurrent()!.nodes[0].id, 'Work continues').ok).toBe(true)
    expect((await manager.saveProject()).ok).toBe(true)
    expect(readFileSync(historyPath, 'utf8')).toBe(damaged)
  })

  it('does not treat a filesystem read failure as missing legacy metadata', async () => {
    expect((await manager.snapshotCreate('baseline')).ok).toBe(true)
    const historyPath = join(projectDir, '.statekeep', 'history.json')
    renameSync(historyPath, `${historyPath}.backup`)
    mkdirSync(historyPath)
    expect(await manager.snapshotCreate('blocked'))
      .toMatchObject({ ok: false, error: { code: 'HISTORY_METADATA_UNAVAILABLE' } })
    expect((await git.listSnapshots(projectDir)).map(snapshot => snapshot.name)).toEqual(['baseline'])
    rmdirSync(historyPath)
    renameSync(`${historyPath}.backup`, historyPath)
    expect((await manager.snapshotTimeline()).ok).toBe(true)
  })

  it.each([
    ['malformed JSON', '{not valid json'],
    ['newer version', JSON.stringify({ version: 999, events: [], recoveryPoints: [], snapshots: {} })],
    ['invalid structure', JSON.stringify({ version: 1, events: 'lost', recoveryPoints: [], snapshots: {} })],
    ['invalid event', JSON.stringify({ version: 1, events: [null], recoveryPoints: [], snapshots: {} })],
  ])('preserves %s metadata and blocks history mutations until restored', async (_label, damaged) => {
    const rootId = manager.getCurrent()!.nodes.find((node) => node.parentId === null)!.id
    expect((await manager.snapshotCreate('baseline', 'Known-good context')).ok).toBe(true)
    manager.nodeCreate(rootId, 'Recoverable rack')
    const reverted = await manager.snapshotRevert({ name: 'baseline' })
    expect(reverted.ok).toBe(true)
    if (!reverted.ok) return
    const recoveryId = reverted.data.safetyRecoveryPoint!.id
    manager.nodeCreate(rootId, 'Current rack')
    await manager.saveProject()
    manager.cancelAutosave()
    await manager.waitForHistoryBackfill()
    const historyPath = join(projectDir, '.statekeep', 'history.json')
    const original = readFileSync(historyPath, 'utf8')
    const document = readFileSync(join(projectDir, PROJECT_DOCUMENT_FILE), 'utf8')
    const current = structuredClone(manager.getCurrent())
    const edits = manager.editHistoryState()
    const snapshots = await git.listSnapshots(projectDir)
    const recoveryFiles = readdirSync(join(projectDir, '.statekeep', 'recovery'))
    writeFileSync(historyPath, damaged, 'utf8')

    for (const result of [
      await manager.snapshotTimeline(),
      await manager.snapshotList(),
      await manager.nodeHistory(rootId),
      await manager.buildReport('baseline', CURRENT_PROJECT_REF, 'html'),
      await manager.snapshotCreate('must-not-exist'),
      await manager.snapshotRevert({ name: 'baseline' }),
      await manager.recoveryPointApply({ id: recoveryId }),
    ]) {
      expect(result).toMatchObject({ ok: false, error: { code: 'HISTORY_METADATA_UNAVAILABLE' } })
      if (!result.ok) expect(result.error.message).toContain(historyPath)
    }
    await manager.waitForHistoryBackfill()
    expect(manager.getHistoryBackfillStatus().inProgress).toBe(false)
    expect(readFileSync(historyPath, 'utf8')).toBe(damaged)
    expect(readFileSync(join(projectDir, PROJECT_DOCUMENT_FILE), 'utf8')).toBe(document)
    expect(manager.getCurrent()).toEqual(current)
    expect(manager.editHistoryState()).toEqual(edits)
    expect(await git.listSnapshots(projectDir)).toEqual(snapshots)
    expect(readdirSync(join(projectDir, '.statekeep', 'recovery'))).toEqual(recoveryFiles)

    // Restoring the original file is sufficient; no restart or destructive reset.
    writeFileSync(historyPath, original, 'utf8')
    const timeline = await manager.snapshotTimeline()
    expect(timeline.ok).toBe(true)
    if (timeline.ok) expect(timeline.data.events[0].note).toBe('Known-good context')
    expect((await manager.recoveryPointApply({ id: recoveryId })).ok).toBe(true)
    expect((await manager.snapshotCreate('after-repair')).ok).toBe(true)
  })
})

describe('per-node history index integration', () => {
  // These tests need direct access to the history index, so they use their own
  // ProjectManager instance instead of the shared `manager` from beforeEach.

  let isolatedTmp: string
  let isolatedManager: ProjectManager
  let isolatedHistory: HistoryIndexService
  let isolatedProjectDir: string

  beforeEach(async () => {
    isolatedTmp = join(tmpdir(), `statekeep-history-int-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(isolatedTmp, { recursive: true })

    const igit = new GitService(noopLogger as any)
    isolatedHistory = new HistoryIndexService()
    isolatedManager = new ProjectManager(igit, noopLogger as any, new SearchIndexService(), isolatedHistory)

    const created = await isolatedManager.createProject('History Project', isolatedTmp)
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error(created.error.message)
    isolatedProjectDir = created.data.path!
  })

  afterEach(async () => {
    isolatedManager.cancelAutosave()
    await isolatedManager.flushAndClose()
    await rm(isolatedTmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  })

  it('writes per-node history rows on snapshotCreate', async () => {
    const rootId = isolatedManager.getCurrent()!.nodes.find((n) => n.parentId === null)!.id
    isolatedManager.nodeCreate(rootId, 'Rack A')
    const created = await isolatedManager.snapshotCreate('baseline')
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const rack = isolatedManager.getCurrent()!.nodes.find((n) => n.name === 'Rack A')!
    expect(isolatedHistory.recordedSnapshotIds().has('baseline')).toBe(true)

    const rackHistory = isolatedHistory.nodeHistory(rack.id)
    expect(rackHistory.length).toBe(1)
    expect(rackHistory[0].presence).toBe('present')
    expect(rackHistory[0].nodeName).toBe('Rack A')
  })

  it('delta-encodes across snapshots — only changed nodes get new rows', async () => {
    const rootId = isolatedManager.getCurrent()!.nodes.find((n) => n.parentId === null)!.id
    isolatedManager.nodeCreate(rootId, 'Rack A')
    isolatedManager.nodeCreate(rootId, 'Rack B')
    await isolatedManager.snapshotCreate('s1')

    const rackA = isolatedManager.getCurrent()!.nodes.find((n) => n.name === 'Rack A')!
    isolatedManager.nodeUpdate(rackA.id, { properties: { firmware: '2.0' } })
    await isolatedManager.snapshotCreate('s2')

    // Rack A changed — two rows. Rack B did not — one row.
    expect(isolatedHistory.nodeHistory(rackA.id).length).toBe(2)
    const rackB = isolatedManager.getCurrent()!.nodes.find((n) => n.name === 'Rack B')!
    expect(isolatedHistory.nodeHistory(rackB.id).length).toBe(1)
  })

  it('records deletion as presence=absent', async () => {
    const rootId = isolatedManager.getCurrent()!.nodes.find((n) => n.parentId === null)!.id
    isolatedManager.nodeCreate(rootId, 'Doomed')
    await isolatedManager.snapshotCreate('s1')

    const doomed = isolatedManager.getCurrent()!.nodes.find((n) => n.name === 'Doomed')!
    isolatedManager.nodeDelete(doomed.id)
    await isolatedManager.snapshotCreate('s2')

    const hist = isolatedHistory.nodeHistory(doomed.id)
    expect(hist.map((r) => [r.snapshotId, r.presence])).toEqual([
      ['s1', 'present'],
      ['s2', 'absent'],
    ])
  })

  it('snapshotCreate succeeds even when history.recordSnapshot throws (regression test for D2)', async () => {
    // Build a faulty history service that throws on record. Every other method
    // returns benign defaults so project lifecycle continues normally.
    const faultyHistory = {
      open: () => {},
      close: () => {},
      recordSnapshot: () => { throw new Error('forced history failure') },
      nodeHistory: () => [],
      recordedSnapshotIds: () => new Set<string>(),
      incompleteSnapshotIds: () => [],
    } as unknown as HistoryIndexService

    const tmp = join(tmpdir(), `statekeep-history-faulty-${Date.now()}`)
    mkdirSync(tmp, { recursive: true })
    const localGit = new GitService(noopLogger as any)
    const faultyManager = new ProjectManager(localGit, noopLogger as any, new SearchIndexService(), faultyHistory)

    try {
      const created = await faultyManager.createProject('Faulty', tmp)
      expect(created.ok).toBe(true)
      if (!created.ok) return
      const projectDir = created.data.path!

      const rootId = faultyManager.getCurrent()!.nodes.find((n) => n.parentId === null)!.id
      faultyManager.nodeCreate(rootId, 'Will Survive')

      const snap = await faultyManager.snapshotCreate('still-works')
      expect(snap.ok).toBe(true)

      // The git tag is real — listing returns the snapshot.
      const listed = await faultyManager.snapshotList()
      expect(listed.ok).toBe(true)
      if (!listed.ok) return
      expect(listed.data.some((s) => s.name === 'still-works')).toBe(true)
    } finally {
      await faultyManager.flushAndClose()
      await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    }
  })

  it('backfill on project open populates history rows for snapshots predating the index', async () => {
    // Create some snapshots, then nuke the history.db to simulate a project
    // that existed before the feature shipped.
    const rootId = isolatedManager.getCurrent()!.nodes.find((n) => n.parentId === null)!.id
    isolatedManager.nodeCreate(rootId, 'A')
    await isolatedManager.snapshotCreate('s1')
    isolatedManager.nodeCreate(rootId, 'B')
    await isolatedManager.snapshotCreate('s2')

    const a = isolatedManager.getCurrent()!.nodes.find((n) => n.name === 'A')!
    expect(isolatedHistory.nodeHistory(a.id).length).toBe(1)

    // Close, wipe history.db, reopen — backfill should run on openProject.
    await isolatedManager.flushAndClose()
    await rm(join(isolatedProjectDir, '.statekeep', 'index', 'history.db'), { force: true, maxRetries: 10, retryDelay: 300 })
    await rm(join(isolatedProjectDir, '.statekeep', 'index', 'history.db-shm'), { force: true, maxRetries: 10, retryDelay: 300 })
    await rm(join(isolatedProjectDir, '.statekeep', 'index', 'history.db-wal'), { force: true, maxRetries: 10, retryDelay: 300 })

    const igit = new GitService(noopLogger as any)
    const refreshedHistory = new HistoryIndexService()
    const refreshedManager = new ProjectManager(igit, noopLogger as any, new SearchIndexService(), refreshedHistory)
    try {
      const reopened = await refreshedManager.openProject(isolatedProjectDir)
      expect(reopened.ok).toBe(true)

      // Backfill is async — wait for it to finish.
      await refreshedManager.waitForHistoryBackfill()

      expect(refreshedHistory.recordedSnapshotIds()).toEqual(new Set(['s1', 's2']))
      expect(refreshedHistory.nodeHistory(a.id).length).toBe(1)
    } finally {
      await refreshedManager.flushAndClose()
    }
  })

  it('backfill resumes from snapshots marked complete=0', async () => {
    const rootId = isolatedManager.getCurrent()!.nodes.find((n) => n.parentId === null)!.id
    isolatedManager.nodeCreate(rootId, 'A')
    await isolatedManager.snapshotCreate('s1')

    // Manually inject a snapshot in `complete=0` state plus a partial row.
    // Simulates a torn write that's been recovered to git but not the index.
    isolatedManager.nodeCreate(rootId, 'B')
    await isolatedManager.snapshotCreate('s2')

    // Now corrupt s2's complete flag.
    const Database = (await import('better-sqlite3')).default
    const dbPath = join(isolatedProjectDir, '.statekeep', 'index', 'history.db')
    await isolatedManager.flushAndClose()  // release WAL handle so direct write is safe
    const db = new Database(dbPath)
    try {
      db.prepare(`UPDATE snapshot_index_state SET complete=0 WHERE snapshot_id='s2'`).run()
    } finally {
      db.close()
    }

    const igit = new GitService(noopLogger as any)
    const refreshedHistory = new HistoryIndexService()
    const refreshedManager = new ProjectManager(igit, noopLogger as any, new SearchIndexService(), refreshedHistory)
    try {
      const reopened = await refreshedManager.openProject(isolatedProjectDir)
      expect(reopened.ok).toBe(true)
      await refreshedManager.waitForHistoryBackfill()

      // s2 should now be complete after backfill catches up.
      expect(refreshedHistory.recordedSnapshotIds().has('s2')).toBe(true)
      expect(refreshedHistory.incompleteSnapshotIds()).toEqual([])
    } finally {
      await refreshedManager.flushAndClose()
    }
  })
})
