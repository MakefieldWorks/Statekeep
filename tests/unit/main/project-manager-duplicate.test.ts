import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
function current() { return manager.getCurrent()! }
function create(name: string, parent = root) {
  return value(manager.nodeCreate(parent, name)).nodes.find(node => node.name === name)!.id
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'statekeep-duplicate-'))
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

describe('duplicate subtree', () => {
  it('copies descendants beside the source, preserves values and order, and undoes/redoes as one edit', async () => {
    create('Before')
    const source = create('Rack')
    create('After')
    const child = create('Device', source)
    create('Sensor', source)
    create('Module', child)
    value(manager.nodeUpdate(child, { properties: { serial: 'ABC', active: true, count: 3, unset: null } }))
    const original = structuredClone(current())
    const copied = value(manager.nodeDuplicate(source, ' Rack copy '))
    const originalIds = new Set(original.nodes.map(node => node.id))
    const newNodes = copied.nodes.filter(node => !originalIds.has(node.id))
    const copy = newNodes.find(node => node.name === 'Rack copy')!
    expect(newNodes).toHaveLength(4)
    expect(new Set(copied.nodes.map(node => node.id)).size).toBe(copied.nodes.length)
    expect(copied.nodes.filter(node => node.parentId === root).sort((a, b) => a.order - b.order).map(node => node.name)).toEqual(['Before', 'Rack', 'Rack copy', 'After'])
    const device = newNodes.find(node => node.name === 'Device')!
    expect(device.parentId).toBe(copy.id)
    expect(device.properties).toEqual(original.nodes.find(node => node.id === child)!.properties)
    expect(newNodes.find(node => node.name === 'Module')!.parentId).toBe(device.id)
    expect(newNodes.filter(node => node.parentId === copy.id).map(node => [node.name, node.order])).toEqual([['Device', 0], ['Sensor', 1]])
    expect(manager.editHistoryState().undoLabel).toBe('Duplicate subtree')
    expect(value(manager.searchNodes('ABC'))).toHaveLength(2)
    value(manager.undo())
    expect(current().nodes).toEqual(original.nodes)
    expect(value(manager.searchNodes('ABC'))).toHaveLength(1)
    value(manager.redo())
    expect(current().nodes).toEqual(copied.nodes)
    value(await manager.flushAndClose())
    const path = join(directory, 'Lab')
    expect(JSON.parse(readFileSync(join(path, 'Statekeep.statekeep'), 'utf8')).nodes).toEqual(copied.nodes)
    value(await manager.openProject(path))
    expect(current().nodes).toEqual(copied.nodes)
  })

  it('remaps typed internal references while preserving external links, incoming links, plain strings, and shared defaults', () => {
    const source = create('Rack')
    const child = create('Device', source)
    const peer = create('Sensor', source)
    const external = create('Power supply')
    const incoming = create('Dependent')
    value(manager.templateCreate('linked', { label: 'Linked', fields: {
      link: { type: 'reference', default: child },
      outside: { type: 'reference' },
      text: { type: 'string' },
    } }))
    value(manager.nodeUpdate(source, { templateId: 'linked', properties: { link: child } }))
    value(manager.nodeUpdate(child, { templateId: 'linked', properties: { link: peer, outside: external, text: peer, untyped: peer } }))
    value(manager.nodeUpdate(peer, { templateId: 'linked', properties: { link: child } }))
    value(manager.nodeUpdate(incoming, { templateId: 'linked', properties: { link: child } }))
    const before = structuredClone(current())
    const oldIds = new Set(before.nodes.map(node => node.id))
    const after = value(manager.nodeDuplicate(source, 'Rack copy'))
    const copies = after.nodes.filter(node => !oldIds.has(node.id))
    const deviceCopy = copies.find(node => node.name === 'Device')!
    const peerCopy = copies.find(node => node.name === 'Sensor')!
    expect(copies.find(node => node.name === 'Rack copy')!.properties.link).toBe(deviceCopy.id)
    expect(deviceCopy.properties).toEqual({ link: peerCopy.id, outside: external, text: peer, untyped: peer })
    expect(peerCopy.properties.link).toBe(deviceCopy.id)
    expect(after.nodes.find(node => node.id === incoming)!.properties.link).toBe(child)
    expect(copies.every(node => node.templateId === 'linked')).toBe(true)
    expect(after.templates).toEqual(before.templates)
    expect(after.templates!.linked.fields.link.default).toBe(child)
    value(manager.undo())
    expect(current().nodes).toEqual(before.nodes)
    value(manager.redo())
    expect(current().nodes).toEqual(after.nodes)
  })

  it('rejects root, missing source, invalid names and sibling collisions without changing history', () => {
    const source = create('Device')
    create('Existing')
    const before = structuredClone(current())
    const history = manager.editHistoryState()
    for (const [id, name] of [[root, 'Root copy'], ['missing', 'Copy'], [source, 'existing'], [source, ''], [source, 'a/b'], [source, 'x'.repeat(256)]]) {
      expect(manager.nodeDuplicate(id, name).ok).toBe(false)
    }
    expect(current()).toEqual(before)
    expect(manager.editHistoryState()).toEqual(history)
  })

  it('rolls back a partial search failure and allows a safe retry', () => {
    const source = create('Rack')
    create('Device', source)
    const before = structuredClone(current())
    const history = manager.editHistoryState()
    const upsert = search.upsertNode.bind(search)
    vi.spyOn(search, 'upsertNode').mockImplementationOnce(upsert).mockImplementationOnce(() => { throw new Error('Disk full') })
    expect(manager.nodeDuplicate(source, 'Copy').ok).toBe(false)
    expect(current()).toEqual(before)
    expect(manager.editHistoryState()).toEqual(history)
    expect(value(manager.searchNodes('Copy'))).toEqual([])
    value(manager.nodeDuplicate(source, 'Copy'))
    expect(value(manager.searchNodes('Copy'))).toHaveLength(1)
  })

  it('rejects ambiguous IDs and a missing parent in hand-edited projects', async () => {
    const source = create('Device')
    const original = structuredClone(current())
    const path = original.path!
    value(await manager.flushAndClose())
    for (const nodes of [
      [...original.nodes, { ...original.nodes[1], name: 'Repeated ID' }],
      original.nodes.map(node => node.id === source ? { ...node, parentId: 'missing' } : node),
    ]) {
      writeFileSync(join(path, 'Statekeep.statekeep'), JSON.stringify({ ...original, nodes }))
      value(await manager.openProject(path))
      expect(manager.nodeDuplicate(source, 'Copy').ok).toBe(false)
      expect(current().nodes).toEqual(nodes)
      expect(manager.editHistoryState().undoLabel).toBeNull()
      manager.discardCurrentProject()
      await manager.waitForHistoryBackfill()
    }
  })
})
