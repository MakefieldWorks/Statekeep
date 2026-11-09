import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectManager } from '../../../src/main/project-manager'
import { GitService } from '../../../src/main/git-service'
import { SearchIndexService } from '../../../src/main/search-index'
import type { Project, Result } from '../../../src/shared/types'

const logger = { info() {}, warn() {}, error() {}, debug() {} }
let directory: string
let manager: ProjectManager
let git: GitService
let search: SearchIndexService
let root: string
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}
function current() { return manager.getCurrent()! }
function create(name: string, parent = root) {
  return value(manager.nodeCreate(parent, name)).nodes.find(node => node.name === name)!.id
}
function content(project = current()) { return structuredClone({ nodes: project.nodes, templates: project.templates }) }

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'statekeep-undo-'))
  git = new GitService(logger)
  search = new SearchIndexService()
  manager = new ProjectManager(git, logger, search)
  root = value(await manager.createProject('Lab', directory)).nodes[0].id
})
afterEach(async () => {
  vi.restoreAllMocks()
  await manager.waitForHistoryBackfill()
  manager.discardCurrentProject()
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('project editing history', () => {
  it('undoes/redoes creation, rename, properties, moves and subtree deletion with original IDs and ordering', () => {
    const baseline = content()
    const a = create('Rack A')
    const b = create('Rack B')
    const device = create('Device', a)
    value(manager.nodeUpdate(device, { name: 'Instrument', properties: { firmware: '2.0', active: true } }))
    value(manager.nodeMove(device, b, 0))
    value(manager.nodeMove(b, root, 0))
    const beforeDelete = content()
    value(manager.nodeDelete(b))
    const afterDelete = content()
    value(manager.undo())
    expect(content()).toEqual(beforeDelete)
    expect(value(manager.searchNodes('Instrument')).map(hit => hit.nodeId)).toEqual([device])
    value(manager.redo())
    expect(content()).toEqual(afterDelete)
    expect(value(manager.searchNodes('Instrument'))).toEqual([])
    for (let i = 0; i < 7; i++) value(manager.undo())
    expect(content()).toEqual(baseline)
    expect(manager.undo().ok).toBe(false)
    for (let i = 0; i < 7; i++) value(manager.redo())
    expect(content()).toEqual(afterDelete)
  })

  it('restores unlinked references and template defaults atomically with deleted nodes', () => {
    const target = create('Target')
    value(manager.templateCreate('linked', { label: 'Linked', fields: { target: { type: 'reference', default: target } } }))
    const holder = value(manager.nodeCreate(root, 'Holder', 'linked')).nodes.find(node => node.name === 'Holder')!.id
    const before = content()
    expect(manager.nodeDelete(target).ok).toBe(false)
    expect(manager.editHistoryState().undoLabel).toBe('Add node')
    value(manager.nodeDelete(target, { unlinkReferences: true }))
    expect(current().nodes.find(node => node.id === holder)!.properties.target).toBeNull()
    value(manager.undo())
    expect(content()).toEqual(before)
    value(manager.redo())
    expect(current().templates!.linked.fields.target.default).toBeUndefined()
  })

  it('restores template definitions, bindings and primitive property types', () => {
    value(manager.templateCreate('device', { label: 'Device', fields: { enabled: { type: 'boolean', default: true } } }))
    value(manager.nodeCreate(root, 'Typed', 'device'))
    const beforeUpdate = content()
    value(manager.templateUpdate('device', { label: 'Instrument' }))
    const beforeDelete = content()
    value(manager.templateDelete('device'))
    value(manager.undo())
    expect(content()).toEqual(beforeDelete)
    value(manager.undo())
    expect(content()).toEqual(beforeUpdate)
    value(manager.redo())
    value(manager.redo())
    expect(current().nodes.find(node => node.name === 'Typed')!.templateId).toBeNull()
  })

  it('records a CSV import as one edit and preserves history across saves', async () => {
    const before = content()
    const csv = join(directory, 'devices.csv')
    writeFileSync(csv, 'name,firmware\nOne,1.0\nTwo,2.0\n')
    value(manager.applyImportCsv(csv, { placement: 'flat', baseParentId: root, nameColumn: 'name', columns: [{ header: 'firmware', key: 'firmware', include: true }] }))
    const imported = content()
    value(await manager.saveProject())
    expect(manager.editHistoryState().undoLabel).toBe('Import CSV')
    value(manager.undo())
    expect(content()).toEqual(before)
    value(manager.redo())
    expect(content()).toEqual(imported)
    value(manager.undo())
    value(await manager.flushAndClose())
    const persisted = JSON.parse(readFileSync(join(directory, 'Lab', 'Statekeep.statekeep'), 'utf8'))
    expect(persisted.nodes).toEqual(before.nodes)
    value(await manager.openProject(join(directory, 'Lab')))
    expect(manager.editHistoryState()).toEqual({ undoLabel: null, redoLabel: null })
  })

  it('does not consume history for failed or no-op edits, and new edits invalidate redo', () => {
    const id = create('Device')
    value(manager.nodeUpdate(id, { name: 'Renamed' }))
    value(manager.undo())
    const state = manager.editHistoryState()
    value(manager.nodeUpdate(id, { name: 'Device' }))
    expect(manager.nodeUpdate(id, { name: '' }).ok).toBe(false)
    expect(manager.editHistoryState()).toEqual(state)
    value(manager.nodeUpdate(id, { properties: { firmware: '3.0' } }))
    expect(manager.editHistoryState().redoLabel).toBeNull()
  })

  it('undoes a NetBox import including its generated templates in one step', () => {
    const before = content()
    const path = join(directory, 'netbox.json')
    writeFileSync(path, JSON.stringify([
      { model: 'dcim.site', pk: 1, fields: { name: 'Imported Lab', status: 'active' } },
      { model: 'dcim.rack', pk: 2, fields: { name: 'Rack', site: 1, status: 'active' } },
    ]))
    value(manager.applyNetboxImport(path, { baseParentId: root }))
    const imported = content()
    expect(imported.nodes.length).toBeGreaterThan(before.nodes.length)
    expect(Object.keys(imported.templates ?? {})).not.toHaveLength(0)
    value(manager.undo())
    expect(content()).toEqual(before)
    value(manager.redo())
    expect(content()).toEqual(imported)
  })

  it('clears history on project switch and preserves it after a failed open or save', async () => {
    create('Device')
    const state = manager.editHistoryState()
    expect((await manager.openProject(join(directory, 'missing'))).ok).toBe(false)
    expect(manager.editHistoryState()).toEqual(state)
    vi.spyOn(manager, 'saveProject').mockResolvedValueOnce({ ok: false, error: { code: 'AUTOSAVE_WRITE_FAILED', message: 'Disk unavailable' } })
    expect((await manager.flushAndClose()).ok).toBe(false)
    expect(manager.editHistoryState()).toEqual(state)
    value(await manager.createProject('Other', directory))
    expect(manager.editHistoryState()).toEqual({ undoLabel: null, redoLabel: null })
    expect(manager.undo().ok).toBe(false)
  })

  it('keeps both stacks and the current project intact when search restoration fails', () => {
    create('Device')
    const before = content()
    const state = manager.editHistoryState()
    vi.spyOn(search, 'rebuild').mockImplementationOnce(() => { throw new Error('disk unavailable') })
    expect(manager.undo().ok).toBe(false)
    expect(content()).toEqual(before)
    expect(manager.editHistoryState()).toEqual(state)
    expect(value(manager.searchNodes('Device'))).toHaveLength(1)
    value(manager.undo())
    expect(value(manager.searchNodes('Device'))).toHaveLength(0)
  })

  it('leaves named snapshots immutable and clears history only when revert/recovery succeeds', async () => {
    create('Baseline device')
    value(await manager.snapshotCreate('baseline'))
    const baseline = await git.readSnapshotDocument(current().path!, 'baseline')
    value(manager.undo())
    expect(await git.readSnapshotDocument(current().path!, 'baseline')).toBe(baseline)
    value(manager.redo())
    create('Later device')
    const state = manager.editHistoryState()
    expect((await manager.snapshotRevert({ name: 'missing' })).ok).toBe(false)
    expect(manager.editHistoryState()).toEqual(state)
    const reverted = value(await manager.snapshotRevert({ name: 'baseline' }))
    expect(manager.editHistoryState()).toEqual({ undoLabel: null, redoLabel: null })
    create('Alternate device')
    value(await manager.recoveryPointApply({ id: reverted.safetyRecoveryPoint!.id }))
    expect(manager.editHistoryState()).toEqual({ undoLabel: null, redoLabel: null })
    expect(current().nodes.some(node => node.name === 'Later device')).toBe(true)
    expect(await git.readSnapshotDocument(current().path!, 'baseline')).toBe(baseline)
  })

  it('blocks undo and edits while an asynchronous snapshot operation is in progress', async () => {
    create('Device')
    let release!: () => void
    const original = git.createSnapshot.bind(git)
    vi.spyOn(git, 'createSnapshot').mockImplementation(async (...args) => {
      await new Promise<void>(resolve => { release = resolve })
      return original(...args)
    })
    const saving = manager.snapshotCreate('baseline')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(manager.undo().ok).toBe(false)
    expect(manager.nodeCreate(root, 'Interleaved').ok).toBe(false)
    release()
    value(await saving)
    value(manager.undo())
    expect(current().nodes).toHaveLength(1)
  })
})
