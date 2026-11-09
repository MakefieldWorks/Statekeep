import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, renameSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ProjectManager } from '../../../src/main/project-manager'
import { GitService } from '../../../src/main/git-service'
import { PROJECT_DOCUMENT_FILE } from '../../../src/main/project-document-file'

const logger = { error() {}, warn() {}, info() {}, debug() {} }
let root: string
let path: string
let file: string
let manager: ProjectManager
let git: GitService
let baseline: Buffer
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'statekeep-external-'))
  git = new GitService(logger as any)
  manager = new ProjectManager(git, logger as any)
  const result = await manager.createProject('External Lab', root)
  if (!result.ok) throw new Error(result.error.message)
  path = result.data.path!
  file = join(path, PROJECT_DOCUMENT_FILE)
  await manager.snapshotCreate('baseline')
  baseline = readFileSync(file)
})
afterEach(async () => {
  vi.restoreAllMocks()
  manager.cancelAutosave()
  await manager.waitForHistoryBackfill()
  manager.discardCurrentProject()
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
function outside() {
  const data = JSON.parse(baseline.toString())
  data.nodes[0].name = 'External root'
  const bytes = Buffer.from(JSON.stringify(data))
  writeFileSync(file, bytes)
  return bytes
}
function preview() {
  const result = manager.reviewExternalDocument()
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}
function copies() {
  return readdirSync(join(path, '.statekeep', 'recovery')).map(name => readFileSync(join(path, '.statekeep', 'recovery', name)))
}

describe('external project document preservation', () => {
  it('keeps the local inventory, undo state, and search index if external-load history persistence fails', async () => {
    manager.nodeCreate(manager.getCurrent()!.nodes[0].id, 'Unsaved local rack')
    const current = structuredClone(manager.getCurrent())
    const edits = manager.editHistoryState()
    const external = outside()
    manager.checkExternalDocument()
    const history = readFileSync(join(path, '.statekeep', 'history.json'))
    const internals = manager as any
    const restore = vi.spyOn(internals, 'restoreSearchIndex')
    vi.spyOn(internals, 'writeSnapshotHistory').mockImplementation(() => { throw new Error('Injected history write failure') })
    expect(await manager.resolveExternalDocument({ token: preview().token, choice: 'load-external' })).toMatchObject({ ok: false })
    expect(manager.getCurrent()).toEqual(current)
    expect(manager.editHistoryState()).toEqual(edits)
    expect(restore).toHaveBeenCalledWith(current)
    expect(internals.search.query(path, 'Unsaved')).toHaveLength(1)
    expect(readFileSync(file)).toEqual(external)
    expect(readFileSync(join(path, '.statekeep', 'history.json'))).toEqual(history)
    expect(manager.documentSaveStatus()).toMatchObject({ ok: true, data: { message: expect.any(String) } })
  })

  it('retains only the active document baseline and clears it on discard', async () => {
    const other = await manager.createProject('Other Lab', root)
    expect(other.ok).toBe(true)
    const versions = (manager as any).documentVersions as Map<string, string | null>
    expect([...versions.keys()]).toEqual([join(root, 'Other Lab', PROJECT_DOCUMENT_FILE)])
    expect((await manager.openProject(path)).ok).toBe(true)
    expect([...versions.keys()]).toEqual([file])
    outside()
    manager.checkExternalDocument()
    await manager.waitForHistoryBackfill()
    manager.discardCurrentProject()
    expect(versions.size).toBe(0)
    expect((manager as any).conflictLocalCopy).toBeNull()
  })

  it('unblocks editing when the outside writer restores the saved bytes', () => {
    outside()
    manager.checkExternalDocument()
    writeFileSync(file, baseline)
    manager.checkExternalDocument()
    expect(manager.documentSaveStatus()).toEqual({ ok: true, data: { message: null } })
    expect(manager.nodeCreate(manager.getCurrent()!.nodes[0].id, 'Resumed').ok).toBe(true)
  })

  it('does not recreate a moved project folder while preserving a conflict', () => {
    // Keep the manager's conflict state, but close its indexes so Windows can
    // rename the folder. Discarding the project would clear the state under test.
    const internals = manager as any
    internals.search.close()
    internals.history.close()
    renameSync(path, `${path}-moved`)
    manager.checkExternalDocument()
    expect(existsSync(path)).toBe(false)
    expect(manager.documentSaveStatus()).toMatchObject({ ok: true, data: { message: expect.stringContaining('project folder is missing') } })
  })

  it('can create a new project at a previously used location', async () => {
    await manager.waitForHistoryBackfill()
    manager.discardCurrentProject()
    rmSync(path, { recursive: true })
    expect((await manager.createProject('External Lab', root)).ok).toBe(true)
  })

  it('can keep local inventory without readable history metadata', async () => {
    outside()
    writeFileSync(join(path, '.statekeep', 'history.json'), '{broken')
    expect((await manager.resolveExternalDocument({ token: preview().token, choice: 'keep-local' })).ok).toBe(true)
    expect(readFileSync(join(path, '.statekeep', 'history.json'), 'utf8')).toBe('{broken')
  })

  it('preserves the original inventory when an outside edit arrives during revert', async () => {
    manager.nodeCreate(manager.getCurrent()!.nodes[0].id, 'Unsaved original')
    const original = git.readSnapshotDocument.bind(git)
    vi.spyOn(git, 'readSnapshotDocument').mockImplementation(async (...args) => {
      outside()
      return original(...args)
    })
    expect((await manager.snapshotRevert({ name: 'baseline' })).ok).toBe(false)
    expect(manager.getCurrent()!.nodes.some(node => node.name === 'Unsaved original')).toBe(true)
    const localCopies = readdirSync(join(path, '.statekeep', 'recovery')).filter(name => name.endsWith('-local.document.json'))
    expect(localCopies.length).toBeGreaterThan(0)
    for (const name of localCopies) expect(readFileSync(join(path, '.statekeep', 'recovery', name), 'utf8')).toContain('Unsaved original')
  })

  it.each(['save', 'snapshot', 'revert', 'close', 'archive', 'focus'])('preserves outside bytes and local edits when conflict is detected by %s', async operation => {
    manager.nodeCreate(manager.getCurrent()!.nodes[0].id, 'Local rack')
    const current = structuredClone(manager.getCurrent())
    const edits = manager.editHistoryState()
    const external = outside()
    const history = readFileSync(join(path, '.statekeep', 'history.json'))
    if (operation === 'save') expect((await manager.saveProject()).ok).toBe(false)
    if (operation === 'snapshot') expect((await manager.snapshotCreate('blocked')).ok).toBe(false)
    if (operation === 'revert') expect((await manager.snapshotRevert({ name: 'baseline' })).ok).toBe(false)
    if (operation === 'close') expect((await manager.flushAndClose()).ok).toBe(false)
    if (operation === 'archive') expect((await manager.exportProjectArchive(join(root, 'blocked.statekeeparchive'))).ok).toBe(false)
    if (operation === 'focus') manager.checkExternalDocument()
    expect(readFileSync(file)).toEqual(external)
    expect(readFileSync(join(path, '.statekeep', 'history.json'))).toEqual(history)
    expect(manager.getCurrent()).toEqual(current)
    expect(manager.editHistoryState()).toEqual(edits)
    expect(copies().some(bytes => JSON.parse(bytes.toString()).nodes.some((node: { name: string }) => node.name === 'Local rack'))).toBe(true)
    expect(manager.nodeCreate(current!.nodes[0].id, 'Blocked').ok).toBe(false)
    expect(manager.undo().ok).toBe(false)
    const count = copies().length
    await manager.saveProject()
    expect(copies()).toHaveLength(count)
  })

  it('detects autosave conflicts without a manual save and keeps a copy for explicit discard', async () => {
    manager.nodeCreate(manager.getCurrent()!.nodes[0].id, 'Autosaved rack')
    const external = outside()
    await new Promise(resolve => setTimeout(resolve, 2700))
    expect(readFileSync(file)).toEqual(external)
    expect(manager.documentSaveStatus()).toMatchObject({ ok: true, data: { message: expect.any(String) } })
    manager.discardCurrentProject()
    expect(copies().some(bytes => bytes.toString().includes('Autosaved rack'))).toBe(true)
  })

  it.each(['keep-local', 'load-external'] as const)('preserves both versions and resumes after %s', async choice => {
    manager.nodeCreate(manager.getCurrent()!.nodes[0].id, 'Local rack')
    const edits = manager.editHistoryState()
    const external = outside()
    await manager.saveProject()
    expect((await manager.resolveExternalDocument({ token: preview().token, choice })).ok).toBe(true)
    expect(copies().some(bytes => bytes.equals(external))).toBe(true)
    expect(copies().some(bytes => bytes.toString().includes('Local rack'))).toBe(true)
    expect(manager.documentSaveStatus()).toMatchObject({ ok: true, data: { message: null } })
    if (choice === 'keep-local') {
      expect(manager.getCurrent()!.nodes).toHaveLength(2)
      expect(manager.editHistoryState()).toEqual(edits)
    } else {
      expect(readFileSync(file)).toEqual(external)
      expect(manager.getCurrent()!.nodes[0].name).toBe('External root')
      expect(manager.editHistoryState()).toEqual({ undoLabel: null, redoLabel: null })
      const history = JSON.parse(readFileSync(join(path, '.statekeep', 'history.json'), 'utf8'))
      expect(history.currentBaseSnapshotId).toBeNull()
      expect(history.pendingRevertEventId).toBeNull()
    }
    expect((await manager.snapshotCreate('after-resolution')).ok).toBe(true)
  })

  it.each(['invalid', 'foreign', 'missing'])('can preserve local inventory when external file is %s', async fault => {
    if (fault === 'invalid') writeFileSync(file, Buffer.from([0xff, 0x7b]))
    if (fault === 'foreign') writeFileSync(file, JSON.stringify({ ...JSON.parse(baseline.toString()), id: 'other-project' }))
    if (fault === 'missing') rmSync(file)
    await manager.saveProject()
    const review = preview()
    expect(review.canLoadExternal).toBe(false)
    expect((await manager.resolveExternalDocument({ token: review.token, choice: 'load-external' })).ok).toBe(false)
    expect((await manager.resolveExternalDocument({ token: review.token, choice: 'keep-local' })).ok).toBe(true)
    expect(existsSync(file)).toBe(true)
  })

  it('rejects a stale review and leaves files unchanged', async () => {
    outside()
    const review = preview()
    writeFileSync(file, '{changed again')
    expect((await manager.resolveExternalDocument({ token: review.token, choice: 'keep-local' })).ok).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('{changed again')
  })

  it('aborts a snapshot if an outside edit arrives between save and staging', async () => {
    const original = git.createSnapshot.bind(git)
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' })
    vi.spyOn(git, 'createSnapshot').mockImplementation(async (...args) => {
      outside()
      return original(...args)
    })
    expect(await manager.snapshotCreate('race')).toMatchObject({ ok: false, error: { code: 'EXTERNAL_DOCUMENT_CHANGED' } })
    expect(manager.interruptedHistoryStatus()).toEqual({ ok: true, data: { pending: false } })
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' })).toBe(head)
    expect((await git.listSnapshots(path)).map(snapshot => snapshot.name)).toEqual(['baseline'])
  })

  it('refuses to create over an existing project', async () => {
    expect((await manager.createProject('External Lab', root)).ok).toBe(false)
    expect(readFileSync(file)).toEqual(baseline)
  })
})
