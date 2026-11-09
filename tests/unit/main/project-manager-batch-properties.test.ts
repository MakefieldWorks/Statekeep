import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectManager } from '../../../src/main/project-manager'
import { GitService } from '../../../src/main/git-service'
import { SearchIndexService } from '../../../src/main/search-index'
import type { Result } from '../../../src/shared/types'

const logger = { info() {}, warn() {}, debug() {}, error() {} }
let manager: ProjectManager
let search: SearchIndexService
let directory: string
let root: string

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

function create(name: string): string {
  return value(manager.nodeCreate(root, name)).nodes.find(node => node.name === name)!.id
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'statekeep-batch-properties-'))
  search = new SearchIndexService()
  manager = new ProjectManager(new GitService(logger), logger, search)
  root = value(await manager.createProject('Lab', directory)).nodes[0].id
})

afterEach(async () => {
  vi.restoreAllMocks()
  await manager.waitForHistoryBackfill()
  manager.discardCurrentProject()
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('batch property updates', () => {
  it('updates the exact node set and undoes/redoes the batch as one edit', () => {
    value(manager.templateCreate('device', { label: 'Device', fields: { firmware: { type: 'version' } } }))
    const a = create('Device A')
    const b = create('Device B')
    const outside = create('Outside')
    value(manager.nodeUpdate(a, { templateId: 'device', properties: { firmware: 'v1' } }))
    value(manager.nodeUpdate(b, { templateId: 'device', properties: { firmware: 'v2' } }))
    value(manager.nodeUpdate(outside, { properties: { firmware: 'leave-me' } }))
    const before = structuredClone(manager.getCurrent()!)

    const applied = value(manager.nodeBatchUpdateProperties({ nodeIds: [a, b], key: 'firmware', clear: false, value: 'v3' }))
    const after = applied.project
    expect(applied.changesApplied).toBe(2)
    expect(after.nodes.find(node => node.id === a)!.properties.firmware).toBe('v3')
    expect(after.nodes.find(node => node.id === b)!.properties.firmware).toBe('v3')
    expect(after.nodes.find(node => node.id === outside)!.properties.firmware).toBe('leave-me')
    expect(manager.editHistoryState().undoLabel).toBe('Batch edit properties')
    expect(value(manager.searchNodes('v3')).map(result => result.nodeId).sort()).toEqual([a, b].sort())

    value(manager.undo())
    expect(manager.getCurrent()!.nodes).toEqual(before.nodes)
    value(manager.redo())
    expect(manager.getCurrent()!.nodes).toEqual(after.nodes)
  })

  it('validates every node before mutation and never applies a partial update', () => {
    value(manager.templateCreate('stateful', { label: 'Stateful', fields: { status: { type: 'enum', options: ['ready', 'offline'] } } }))
    const a = create('A')
    const b = create('B')
    value(manager.nodeUpdate(a, { templateId: 'stateful', properties: { status: 'ready' } }))
    value(manager.nodeUpdate(b, { templateId: 'stateful', properties: { status: 'offline' } }))
    const before = structuredClone(manager.getCurrent()!)
    const history = manager.editHistoryState()

    expect(manager.nodeBatchUpdateProperties({ nodeIds: [a, b], key: 'status', clear: false, value: 'retired' }).ok).toBe(false)
    expect(manager.getCurrent()).toEqual(before)
    expect(manager.editHistoryState()).toEqual(history)
  })

  it('clears a property only where it is present and does not create a no-op history entry', () => {
    const a = create('A')
    const b = create('B')
    value(manager.nodeUpdate(a, { properties: { serial: '123' } }))
    const first = value(manager.nodeBatchUpdateProperties({ nodeIds: [a, b], key: 'serial', clear: true }))
    expect(first.changesApplied).toBe(1)
    expect(first.project.nodes.find(node => node.id === a)!.properties.serial).toBeUndefined()
    expect(manager.editHistoryState().undoLabel).toBe('Batch edit properties')
    const history = manager.editHistoryState()
    expect(value(manager.nodeBatchUpdateProperties({ nodeIds: [a, b], key: 'serial', clear: true })).changesApplied).toBe(0)
    expect(manager.editHistoryState()).toEqual(history)
  })

  it('rolls back every node and the search index when indexing fails partway through', () => {
    const a = create('A')
    const b = create('B')
    const before = structuredClone(manager.getCurrent()!)
    const history = manager.editHistoryState()
    const upsert = search.upsertNode.bind(search)
    vi.spyOn(search, 'upsertNode').mockImplementationOnce(upsert).mockImplementationOnce(() => { throw new Error('Index unavailable') })

    expect(manager.nodeBatchUpdateProperties({ nodeIds: [a, b], key: 'firmware', clear: false, value: 'v3' }).ok).toBe(false)
    expect(manager.getCurrent()).toEqual(before)
    expect(manager.editHistoryState()).toEqual(history)
    expect(value(manager.searchNodes('v3'))).toEqual([])
  })
})
