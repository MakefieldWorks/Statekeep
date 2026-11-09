import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ProjectManager } from '../../../src/main/project-manager'
import { GitService } from '../../../src/main/git-service'
import { PROJECT_DOCUMENT_FILE } from '../../../src/main/project-document-file'

const logger = { info() {}, warn() {}, error() {}, debug() {} }
let manager: ProjectManager
let git: GitService
let root: string
let source: string
let archive: string
let target: string
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'statekeep-archive-test-'))
  git = new GitService(logger as any)
  manager = new ProjectManager(git, logger as any)
  const result = await manager.createProject('Archive Lab', root)
  if (!result.ok) throw new Error(result.error.message)
  source = result.data.path!
  archive = join(root, 'project.statekeeparchive')
  target = join(root, 'restores')
  mkdirSync(target)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await manager.waitForHistoryBackfill()
  await manager.flushAndClose()
  // Safe if flushAndClose already discarded; also closes indexes after a failed save.
  manager.discardCurrentProject()
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
async function exportArchive() {
  const result = await manager.exportProjectArchive(archive)
  if (!result.ok) throw new Error(result.error.message)
}
async function preview() {
  const result = await manager.inspectProjectArchive(archive)
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}
async function restore() {
  const result = await manager.restoreProjectArchive((await preview()).token, target)
  if (!result.ok) throw new Error(result.error.message)
  return result.data.path
}
function editArchive(edit: (data: any) => void) {
  const data = JSON.parse(readFileSync(archive, 'utf8'))
  edit(data)
  writeFileSync(archive, JSON.stringify(data))
}

describe('portable project archives', () => {
  it('round trips unsaved inventory, Git snapshots, notes, Windows recovery paths, and opaque preserved files', async () => {
    await manager.snapshotCreate('baseline', 'Evidence note')
    manager.nodeCreate(manager.getCurrent()!.nodes[0].id, 'Safety rack')
    const reverted = await manager.snapshotRevert({ name: 'baseline' })
    if (!reverted.ok || !reverted.data.safetyRecoveryPoint) throw new Error('Missing safety point')
    const historyPath = join(source, '.statekeep', 'history.json')
    const history = JSON.parse(readFileSync(historyPath, 'utf8'))
    history.recoveryPoints[0].payloadPath = history.recoveryPoints[0].payloadPath.replaceAll('/', '\\')
    writeFileSync(historyPath, JSON.stringify(history))
    writeFileSync(join(source, '.statekeep', 'history.json.damaged-test'), Buffer.from([0xff, 0x00]))
    writeFileSync(join(source, '.statekeep', 'recovery', 'unlisted.txt'), 'preserve me')
    manager.nodeCreate(manager.getCurrent()!.nodes[0].id, 'Unsaved rack')
    const before = structuredClone(manager.getCurrent())
    const undo = manager.editHistoryState()
    const refs = await git.archiveRefs(source)
    await exportArchive()
    const inspected = await preview()
    expect(inspected).toMatchObject({ projectName: 'Archive Lab', snapshotCount: 1, recoveryFileCount: 2 })
    const restored = await restore()
    // The independent autosave timer may advance modified while archive
    // verification runs; inventory and undo must remain unchanged.
    expect(manager.getCurrent()).toEqual({ ...before, modified: manager.getCurrent()!.modified })
    expect(manager.editHistoryState()).toEqual(undo)
    expect(await git.archiveRefs(restored)).toBe(refs)
    expect(readFileSync(join(restored, '.statekeep', 'history.json'))).toEqual(readFileSync(historyPath))
    expect(readFileSync(join(restored, '.statekeep', 'history.json.damaged-test'))).toEqual(Buffer.from([0xff, 0x00]))
    expect(readFileSync(join(restored, '.statekeep', 'recovery', 'unlisted.txt'), 'utf8')).toBe('preserve me')
    expect(existsSync(join(restored, '.statekeep', 'index'))).toBe(false)
    const other = new ProjectManager(new GitService(logger as any), logger as any)
    try {
      expect((await other.openProject(restored)).ok).toBe(true)
      expect(other.getCurrent()!.nodes.some(node => node.name === 'Unsaved rack')).toBe(true)
      expect((await other.recoveryPointApply({ id: history.recoveryPoints[0].id })).ok).toBe(true)
      expect(other.getCurrent()!.nodes.some(node => node.name === 'Safety rack')).toBe(true)
      expect((await other.snapshotCreate('after-restore')).ok).toBe(true)
    } finally {
      await other.waitForHistoryBackfill()
      await other.flushAndClose()
      other.discardCurrentProject()
    }
  })

  it('supports legacy absent history and restores repeatedly to distinct new folders', async () => {
    await exportArchive()
    const a = await restore()
    const b = await restore()
    expect(a).not.toBe(b)
    expect(existsSync(join(a, PROJECT_DOCUMENT_FILE))).toBe(true)
    expect(existsSync(join(b, PROJECT_DOCUMENT_FILE))).toBe(true)
  })

  it.each(['hash', 'path', 'duplicate', 'future', 'missing', 'truncated', 'bundle'])('rejects %s corruption without destination writes', async fault => {
    await exportArchive()
    if (fault === 'truncated') writeFileSync(archive, readFileSync(archive).subarray(0, 60))
    else editArchive(data => {
      if (fault === 'hash') data.entries[0].sha256 = '0'.repeat(64)
      if (fault === 'path') data.entries[0].path = '../escape'
      if (fault === 'duplicate') data.entries.push(data.entries[0])
      if (fault === 'future') data.version = 999
      if (fault === 'missing') data.entries = []
      if (fault === 'bundle') {
        const entry = data.entries.find((entry: any) => entry.path === 'snapshots.bundle')
        entry.data = Buffer.from('not a bundle').toString('base64')
        entry.sha256 = createHash('sha256').update('not a bundle').digest('hex')
      }
    })
    expect((await manager.inspectProjectArchive(archive)).ok).toBe(false)
    expect(readdirSync(target)).toEqual([])
  })

  it('rejects a changed archive between preview and restore', async () => {
    await exportArchive()
    const review = await preview()
    writeFileSync(archive, readFileSync(archive, 'utf8') + '\n')
    expect((await manager.restoreProjectArchive(review.token, target)).ok).toBe(false)
    expect(readdirSync(target)).toEqual([])
  })

  it('preserves an existing export destination on failure', async () => {
    writeFileSync(archive, 'previous archive')
    await manager.snapshotCreate('baseline')
    writeFileSync(join(source, '.statekeep', 'history.json'), '{bad')
    expect((await manager.exportProjectArchive(archive)).ok).toBe(false)
    expect(readFileSync(archive, 'utf8')).toBe('previous archive')
    expect((await manager.exportProjectArchive(join(source, PROJECT_DOCUMENT_FILE))).ok).toBe(false)
  })

  it('rejects linked source files and missing registered recovery payloads', async () => {
    await manager.snapshotCreate('baseline')
    manager.nodeCreate(manager.getCurrent()!.nodes[0].id, 'Rack')
    const result = await manager.snapshotRevert({ name: 'baseline' })
    if (!result.ok) throw new Error('revert failed')
    const payload = join(source, result.data.safetyRecoveryPoint!.payloadPath)
    rmSync(payload)
    expect((await manager.exportProjectArchive(archive)).ok).toBe(false)
    symlinkSync(join(source, PROJECT_DOCUMENT_FILE), payload)
    expect((await manager.exportProjectArchive(archive)).ok).toBe(false)
  })

  it('does not carry local hooks, remotes, or non-snapshot refs', async () => {
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/private'], { cwd: source })
    execFileSync('git', ['branch', 'private-branch'], { cwd: source })
    writeFileSync(join(source, '.git', 'hooks', 'pre-commit'), 'not portable')
    await exportArchive()
    const restored = await restore()
    expect(execFileSync('git', ['remote'], { cwd: restored, encoding: 'utf8' })).toBe('')
    expect(existsSync(join(restored, '.git', 'hooks', 'pre-commit'))).toBe(false)
    expect(execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: restored, encoding: 'utf8' }).trim()).toBe('main')
  })

  it('cleans its own new folder if restoration fails and leaves existing folders alone', async () => {
    await exportArchive()
    const review = await preview()
    mkdirSync(join(target, 'existing'))
    vi.spyOn(git, 'restoreArchiveBundle').mockRejectedValue(new Error('injected failure'))
    expect((await manager.restoreProjectArchive(review.token, target)).ok).toBe(false)
    expect(readdirSync(target)).toEqual(['existing'])
    vi.restoreAllMocks()
    expect(await manager.restoreProjectArchive(review.token, target)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect((await manager.restoreProjectArchive((await preview()).token, target)).ok).toBe(true)
  })

  it('rejects export destinations hidden behind links or dot-prefixed source directories', async () => {
    const alias = join(root, 'alias')
    symlinkSync(source, alias)
    expect((await manager.exportProjectArchive(join(alias, PROJECT_DOCUMENT_FILE))).ok).toBe(false)
    mkdirSync(join(source, '..exports'))
    expect((await manager.exportProjectArchive(join(source, '..exports', 'copy.statekeeparchive'))).ok).toBe(false)
  })

  it('blocks edits during capture and refuses externally changed snapshot refs', async () => {
    const original = git.createArchiveBundle.bind(git)
    vi.spyOn(git, 'createArchiveBundle').mockImplementation(async (path, destination) => {
      expect(manager.nodeCreate(manager.getCurrent()!.nodes[0].id, 'Blocked').ok).toBe(false)
      expect((await manager.createProject('Blocked', root)).ok).toBe(false)
      await original(path, destination)
      execFileSync('git', ['tag', 'snapshot/external', 'HEAD'], { cwd: path })
    })
    expect((await manager.exportProjectArchive(archive)).ok).toBe(false)
    expect(existsSync(archive)).toBe(false)
  })

  it('rejects an otherwise valid bundle containing unrelated branches', async () => {
    await exportArchive()
    const bundle = join(root, 'extra.bundle')
    execFileSync('git', ['bundle', 'create', bundle, '--all'], { cwd: source })
    const bytes = readFileSync(bundle)
    editArchive(data => {
      const entry = data.entries.find((entry: any) => entry.path === 'snapshots.bundle')
      entry.data = bytes.toString('base64')
      entry.sha256 = createHash('sha256').update(bytes).digest('hex')
    })
    expect((await manager.inspectProjectArchive(archive)).ok).toBe(false)
  })

  it('transfers hundreds of long snapshot names with fixed-size Git refspecs', async () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
    const names = Array.from({ length: 350 }, (_, i) => `refs/tags/snapshot/${String(i).padStart(4, '0')}-${'x'.repeat(55)}`)
    execFileSync('git', ['update-ref', '--stdin'], { cwd: source, input: names.map(name => `create ${name} ${head}`).join('\n') + '\n' })
    const bundle = join(root, 'many.bundle')
    await git.createArchiveBundle(source, bundle)
    const restored = join(target, 'many')
    mkdirSync(restored)
    await git.restoreArchiveBundle(restored, bundle)
    expect(await git.archiveRefs(restored)).toBe(await git.archiveRefs(source))
  })
})
