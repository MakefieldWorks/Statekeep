// Unit tests for Phase 2 node CRUD operations in ProjectManager.
// Uses real filesystem via tmp directories, never mocks.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { ProjectManager } from '../../../src/main/project-manager'
import { SearchIndexService } from '../../../src/main/search-index'
import type { Project } from '../../../src/shared/types'

// Minimal logger stub — writes nothing, throws nothing.
const noopLogger = {
  error: () => {},
  warn:  () => {},
  info:  () => {},
  debug: () => {},
}

// Minimal git stub — we don't test git in this suite.
const noopGit = {
  checkVersion: async () => ({ available: true, version: '2.50.0', meetsMinimum: true, minimumVersion: '2.25' }),
  initRepo:     async () => {},
  initialCommit: async () => {},
  run: async () => ({ stdout: '', stderr: '' }),
}

function makeManager(search?: SearchIndexService): ProjectManager {
  return new ProjectManager(noopGit as any, noopLogger as any, search)
}

let tmpDir: string
let manager: ProjectManager
let search: SearchIndexService
let project: Project

// ─── Helpers ──────────────────────────────────────────────────────────────────

function writeFixture(dir: string, data: object) {
  writeFileSync(join(dir, 'Statekeep.statekeep'), JSON.stringify(data, null, 2), 'utf8')
}

// Build a minimal v2 document with a single root node.
function makeDocument(overrides: Partial<object> = {}) {
  return {
    version: 2,
    id: 'test-project-id',
    name: 'Test Project',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    nodes: [
      {
        id: 'root-id',
        parentId: null,
        name: 'Test Project',
        order: 0,
        properties: {},
        created: '2026-01-01T00:00:00.000Z',
        modified: '2026-01-01T00:00:00.000Z',
      },
    ],
    ...overrides,
  }
}

beforeEach(async () => {
  tmpDir = join(tmpdir(), `statekeep-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
  writeFixture(tmpDir, makeDocument())

  search = new SearchIndexService()
  manager = makeManager(search)
  const result = await manager.openProject(tmpDir)
  expect(result.ok).toBe(true)
  project = (result as any).data
})

afterEach(async () => {
  manager.cancelAutosave()
  await manager.waitForHistoryBackfill()
  await manager.flushAndClose()
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

// ─── nodeCreate ───────────────────────────────────────────────────────────────

describe('nodeCreate', () => {
  it('creates a child under the root', () => {
    const result = manager.nodeCreate('root-id', 'Server 1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const newNode = result.data.nodes.find(n => n.name === 'Server 1')
    expect(newNode).toBeDefined()
    expect(newNode!.parentId).toBe('root-id')
    expect(newNode!.order).toBe(0)
  })

  it('assigns sequential order to siblings', () => {
    manager.nodeCreate('root-id', 'Alpha')
    const result = manager.nodeCreate('root-id', 'Beta')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const beta = result.data.nodes.find(n => n.name === 'Beta')
    expect(beta!.order).toBe(1)
  })

  it('rejects empty name', () => {
    const result = manager.nodeCreate('root-id', '')
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects name with slash', () => {
    const result = manager.nodeCreate('root-id', 'bad/name')
    expect(result.ok).toBe(false)
  })

  it('rejects duplicate sibling name (case-insensitive)', () => {
    manager.nodeCreate('root-id', 'Server 1')
    const result = manager.nodeCreate('root-id', 'server 1')
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects non-existent parent', () => {
    const result = manager.nodeCreate('no-such-parent', 'Orphan')
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('INVALID_HIERARCHY')
  })

  it('returns the full updated project', () => {
    const result = manager.nodeCreate('root-id', 'New Node')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Root + new node
    expect(result.data.nodes.length).toBe(2)
  })
})

// ─── nodeUpdate ───────────────────────────────────────────────────────────────

describe('nodeUpdate', () => {
  beforeEach(() => {
    manager.nodeCreate('root-id', 'Server 1')
  })

  it('renames a node', () => {
    const node = manager.getCurrent()!.nodes.find(n => n.name === 'Server 1')!
    const result = manager.nodeUpdate(node.id, { name: 'Server Renamed' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.nodes.find(n => n.id === node.id)!.name).toBe('Server Renamed')
  })

  it('rejects rename to existing sibling name', () => {
    manager.nodeCreate('root-id', 'Server 2')
    const node = manager.getCurrent()!.nodes.find(n => n.name === 'Server 1')!
    const result = manager.nodeUpdate(node.id, { name: 'server 2' })
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('VALIDATION_FAILED')
  })

  it('allows renaming root node', () => {
    const result = manager.nodeUpdate('root-id', { name: 'New Root Name' })
    expect(result.ok).toBe(true)
  })

  it('adds a property', () => {
    const node = manager.getCurrent()!.nodes.find(n => n.name === 'Server 1')!
    const result = manager.nodeUpdate(node.id, { properties: { serial: 'SN-001' } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.nodes.find(n => n.id === node.id)!.properties['serial']).toBe('SN-001')
  })

  it('rejects invalid property key', () => {
    const node = manager.getCurrent()!.nodes.find(n => n.name === 'Server 1')!
    const result = manager.nodeUpdate(node.id, { properties: { 'bad key!': 'value' } })
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects property value over 10,000 chars', () => {
    const node = manager.getCurrent()!.nodes.find(n => n.name === 'Server 1')!
    const result = manager.nodeUpdate(node.id, { properties: { notes: 'x'.repeat(10001) } })
    expect(result.ok).toBe(false)
  })

  it('returns error for non-existent node', () => {
    const result = manager.nodeUpdate('ghost-id', { name: 'Ghost' })
    expect(result.ok).toBe(false)
  })
})

// ─── nodeDelete ───────────────────────────────────────────────────────────────

describe('nodeDelete', () => {
  it('deletes a leaf node', () => {
    manager.nodeCreate('root-id', 'Leaf')
    const leaf = manager.getCurrent()!.nodes.find(n => n.name === 'Leaf')!
    const result = manager.nodeDelete(leaf.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.nodes.find(n => n.id === leaf.id)).toBeUndefined()
  })

  it('cascades: deletes node and all descendants', () => {
    manager.nodeCreate('root-id', 'Parent')
    const parent = manager.getCurrent()!.nodes.find(n => n.name === 'Parent')!
    manager.nodeCreate(parent.id, 'Child A')
    manager.nodeCreate(parent.id, 'Child B')
    const childA = manager.getCurrent()!.nodes.find(n => n.name === 'Child A')!
    manager.nodeCreate(childA.id, 'Grandchild')

    const result = manager.nodeDelete(parent.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Only root survives.
    expect(result.data.nodes.length).toBe(1)
    expect(result.data.nodes[0].id).toBe('root-id')
  })

  it('rejects deleting root node', () => {
    const result = manager.nodeDelete('root-id')
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('INVALID_HIERARCHY')
  })

  it('rejects deleting non-existent node', () => {
    const result = manager.nodeDelete('ghost-id')
    expect(result.ok).toBe(false)
  })

  it('renumbers siblings after deletion', () => {
    manager.nodeCreate('root-id', 'A')
    manager.nodeCreate('root-id', 'B')
    manager.nodeCreate('root-id', 'C')
    const b = manager.getCurrent()!.nodes.find(n => n.name === 'B')!
    const result = manager.nodeDelete(b.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const siblings = result.data.nodes
      .filter(n => n.parentId === 'root-id')
      .sort((a, b) => a.order - b.order)
    expect(siblings.map(n => n.order)).toEqual([0, 1])
    expect(siblings.map(n => n.name)).toEqual(['A', 'C'])
  })
})

// ─── nodeMove (reorder) ───────────────────────────────────────────────────────

describe('nodeMove — reorder', () => {
  beforeEach(() => {
    manager.nodeCreate('root-id', 'A')
    manager.nodeCreate('root-id', 'B')
    manager.nodeCreate('root-id', 'C')
  })

  it('moves a node up within siblings', () => {
    const b = manager.getCurrent()!.nodes.find(n => n.name === 'B')!
    const result = manager.nodeMove(b.id, 'root-id', 0)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const siblings = result.data.nodes
      .filter(n => n.parentId === 'root-id')
      .sort((a, b) => a.order - b.order)
    expect(siblings.map(n => n.name)).toEqual(['B', 'A', 'C'])
  })

  it('moves a node down within siblings', () => {
    const b = manager.getCurrent()!.nodes.find(n => n.name === 'B')!
    const result = manager.nodeMove(b.id, 'root-id', 2)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const siblings = result.data.nodes
      .filter(n => n.parentId === 'root-id')
      .sort((a, b) => a.order - b.order)
    expect(siblings.map(n => n.name)).toEqual(['A', 'C', 'B'])
  })

  it('no-op when already in position', () => {
    const b = manager.getCurrent()!.nodes.find(n => n.name === 'B')!
    const before = manager.getCurrent()!.nodes.map(n => n.order)
    const result = manager.nodeMove(b.id, 'root-id', 1)
    expect(result.ok).toBe(true)
  })
})

// ─── nodeMove (reparent) ──────────────────────────────────────────────────────

describe('nodeMove — reparent', () => {
  it('reparents a node to a different parent', () => {
    manager.nodeCreate('root-id', 'Rack A')
    manager.nodeCreate('root-id', 'Rack B')
    const rackA = manager.getCurrent()!.nodes.find(n => n.name === 'Rack A')!
    const rackB = manager.getCurrent()!.nodes.find(n => n.name === 'Rack B')!
    manager.nodeCreate(rackA.id, 'Server 1')
    const server = manager.getCurrent()!.nodes.find(n => n.name === 'Server 1')!

    const result = manager.nodeMove(server.id, rackB.id, 999)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.nodes.find(n => n.id === server.id)!.parentId).toBe(rackB.id)
  })

  it('rejects moving a node into its own descendant', () => {
    manager.nodeCreate('root-id', 'Parent')
    const parent = manager.getCurrent()!.nodes.find(n => n.name === 'Parent')!
    manager.nodeCreate(parent.id, 'Child')
    const child = manager.getCurrent()!.nodes.find(n => n.name === 'Child')!

    const result = manager.nodeMove(parent.id, child.id, 0)
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('INVALID_HIERARCHY')
  })

  it('rejects moving root node', () => {
    manager.nodeCreate('root-id', 'Other')
    const other = manager.getCurrent()!.nodes.find(n => n.name === 'Other')!
    const result = manager.nodeMove('root-id', other.id, 0)
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('INVALID_HIERARCHY')
  })

  it('rejects move to non-existent parent', () => {
    manager.nodeCreate('root-id', 'Node')
    const node = manager.getCurrent()!.nodes.find(n => n.name === 'Node')!
    const result = manager.nodeMove(node.id, 'ghost-parent', 0)
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('INVALID_HIERARCHY')
  })
})

// ─── searchNodes ──────────────────────────────────────────────────────────────
// Full search round-trip: ProjectManager writes through SearchIndexService into
// a real better-sqlite3 FTS5 index in the project's tmp dir, then queries it.

describe('searchNodes', () => {
  beforeEach(() => {
    manager.nodeCreate('root-id', 'Oscilloscope')
    const osc = manager.getCurrent()!.nodes.find(n => n.name === 'Oscilloscope')!
    manager.nodeUpdate(osc.id, { properties: { serial: 'MSO-4054C', firmware: 'v3.2' } })
    manager.nodeCreate('root-id', 'Power Supply')
  })

  it('matches by node name', () => {
    const result = manager.searchNodes('Oscilloscope')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.some(r => r.nodeName === 'Oscilloscope')).toBe(true)
  })

  it('matches by property value', () => {
    const result = manager.searchNodes('MSO-4054C')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.length).toBeGreaterThan(0)
    expect(result.data[0].matchField).toBe('property')
  })

  it('is case-insensitive', () => {
    const result = manager.searchNodes('oscilloscope')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.some(r => r.nodeName === 'Oscilloscope')).toBe(true)
  })

  it('pages through every match with an exact total, stable boundaries, and bounded page sizes', () => {
    for (let index = 1; index <= 205; index++) {
      expect(manager.nodeCreate('root-id', `Inventory Device ${String(index).padStart(2, '0')}`).ok).toBe(true)
    }

    const first = manager.searchNodesPage('Inventory Device', 0, 50)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.data.total).toBe(205)
    expect(first.data.results).toHaveLength(50)
    expect(first.data.offset).toBe(0)
    expect(first.data.hasMore).toBe(true)

    const pages = [first]
    for (const offset of [50, 100, 150, 200]) {
      const page = manager.searchNodesPage('Inventory Device', offset, 50)
      expect(page.ok).toBe(true)
      if (page.ok) pages.push(page)
    }
    expect(pages[4]?.data.results).toHaveLength(5)
    expect(pages[4]?.data.hasMore).toBe(false)

    const allIds = pages.flatMap(page => page.data.results.map(result => result.nodeId))
    expect(new Set(allIds).size).toBe(205)

    const bounded = manager.searchNodesPage('Inventory Device', -10, 500)
    expect(bounded.ok).toBe(true)
    if (!bounded.ok) return
    expect(bounded.data.offset).toBe(0)
    expect(bounded.data.results).toHaveLength(200)
    expect(bounded.data.hasMore).toBe(true)

    const nonFinite = manager.searchNodesPage('Inventory Device', Number.NaN, Number.POSITIVE_INFINITY)
    expect(nonFinite.ok).toBe(true)
    if (!nonFinite.ok) return
    expect(nonFinite.data.offset).toBe(0)
    expect(nonFinite.data.results).toHaveLength(50)
  })

  it('rebuilds before counting when the search index contains a stale node', () => {
    search.upsertNode(tmpDir, {
      id: 'stale-node',
      parentId: 'root-id',
      name: 'Stale Inventory Device',
      order: 99,
      properties: {},
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
    })

    const result = manager.searchNodesPage('Stale Inventory Device')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toEqual({ results: [], total: 0, offset: 0, hasMore: false })
  })

  it('combines structured filters with text search and supports filter-only results', () => {
    expect(manager.templateCreate('device', {
      label: 'Device',
      fields: {
        serial: { type: 'string', required: true },
        firmware: { type: 'version' },
      },
    }).ok).toBe(true)
    expect(manager.nodeCreate('root-id', 'Rack A').ok).toBe(true)
    const rack = manager.getCurrent()!.nodes.find(node => node.name === 'Rack A')!
    expect(manager.nodeCreate(rack.id, 'Device A', 'device').ok).toBe(true)
    expect(manager.nodeCreate(rack.id, 'Device B', 'device').ok).toBe(true)
    const deviceA = manager.getCurrent()!.nodes.find(node => node.name === 'Device A')!
    const deviceB = manager.getCurrent()!.nodes.find(node => node.name === 'Device B')!
    expect(manager.nodeUpdate(deviceA.id, { properties: { firmware: 'v3.2' } }).ok).toBe(true)
    expect(manager.nodeUpdate(deviceB.id, { properties: { serial: 'SN-2', firmware: 'v2.0' } }).ok).toBe(true)

    const missing = manager.searchNodesPage('', 0, 50, { missingRequired: true })
    expect(missing.ok).toBe(true)
    if (!missing.ok) return
    expect(missing.data.total).toBe(1)
    expect(missing.data.offset).toBe(0)
    expect(missing.data.hasMore).toBe(false)
    expect(missing.data.results[0]).toMatchObject({
      nodeId: deviceA.id,
      matchField: 'property',
      snippet: 'Missing: serial',
    })

    const templatePage = manager.searchNodesPage('', 0, 1, { templateId: 'device' })
    expect(templatePage.ok).toBe(true)
    if (!templatePage.ok) return
    expect(templatePage.data).toMatchObject({ total: 2, offset: 0, hasMore: true })
    expect(templatePage.data.results[0]?.matchField).toBe('filter')

    const combined = manager.searchNodesPage('Device', 0, 50, {
      subtreeId: rack.id,
      templateId: 'device',
      propertyKey: 'firmware',
      propertyOperator: 'contains',
      propertyValue: '2.',
    })
    expect(combined.ok).toBe(true)
    if (!combined.ok) return
    expect(combined.data.total).toBe(1)
    expect(combined.data.results[0]?.nodeId).toBe(deviceB.id)

    const invalid = manager.searchNodesPage('', 0, 50, {
      propertyKey: 'x'.repeat(65),
      propertyValue: 'value',
    })
    expect(invalid.ok).toBe(false)
  })

  it('returns empty array for no match', () => {
    const result = manager.searchNodes('xyzzy-no-match')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toEqual([])
  })

  it('returns empty array for empty query', () => {
    const result = manager.searchNodes('')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toEqual([])
  })

  it('returns empty array for whitespace-only query', () => {
    const result = manager.searchNodes('   ')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toEqual([])
  })

  it('reflects newly created nodes without reopening', () => {
    const result = manager.searchNodes('Power Supply')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.some(r => r.nodeName === 'Power Supply')).toBe(true)
  })

  it('reflects updates without reopening', () => {
    const osc = manager.getCurrent()!.nodes.find(n => n.name === 'Oscilloscope')!
    const updated = manager.nodeUpdate(osc.id, { properties: { serial: 'MSO-5000', firmware: 'v3.3' } })
    expect(updated.ok).toBe(true)

    const result = manager.searchNodes('MSO-5000')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.some(r => r.nodeName === 'Oscilloscope')).toBe(true)
  })

  it('removes deleted nodes from search results', () => {
    const osc = manager.getCurrent()!.nodes.find(n => n.name === 'Oscilloscope')!
    const deleted = manager.nodeDelete(osc.id)
    expect(deleted.ok).toBe(true)

    const result = manager.searchNodes('Oscilloscope')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toEqual([])
  })

  it('keeps parent metadata current after a move', () => {
    manager.nodeCreate('root-id', 'Cabinet')
    const cabinet = manager.getCurrent()!.nodes.find(n => n.name === 'Cabinet')!
    const osc = manager.getCurrent()!.nodes.find(n => n.name === 'Oscilloscope')!

    const moved = manager.nodeMove(osc.id, cabinet.id, 999)
    expect(moved.ok).toBe(true)

    const result = manager.searchNodes('Oscilloscope')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data[0]?.parentName).toBe('Cabinet')
  })

  it('rebuilds the index from document contents on open', async () => {
    await manager.flushAndClose()

    writeFixture(tmpDir, makeDocument({
      nodes: [
        {
          id: 'root-id',
          parentId: null,
          name: 'Test Project',
          order: 0,
          properties: {},
          created: '2026-01-01T00:00:00.000Z',
          modified: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'node-a',
          parentId: 'root-id',
          name: 'Signal Generator',
          order: 0,
          properties: { serial: 'SG-1000' },
          created: '2026-01-01T00:00:00.000Z',
          modified: '2026-01-01T00:00:00.000Z',
        },
      ],
    }))

    manager = makeManager()
    const reopened = await manager.openProject(tmpDir)
    expect(reopened.ok).toBe(true)

    const result = manager.searchNodes('SG-1000')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.some(r => r.nodeName === 'Signal Generator')).toBe(true)
  })
})

describe('inventory table and export', () => {
  it('sorts and pages the complete filtered set and exports the same rows', () => {
    manager.nodeCreate('root-id', 'Device 10')
    manager.nodeCreate('root-id', 'Device 2')
    const devices = manager.getCurrent()!.nodes.filter(node => node.name.startsWith('Device'))
    manager.nodeUpdate(devices[0].id, { properties: { firmware: 'v3.1' } })
    manager.nodeUpdate(devices[1].id, { properties: { firmware: 'v3.2' } })

    const request = {
      query: 'Device',
      filters: { propertyKey: 'firmware', propertyValue: 'v3', propertyOperator: 'contains' },
      columns: ['name', 'path', 'property:firmware'],
      sortColumn: 'name',
      sortDirection: 'asc',
      offset: 0,
      limit: 1,
    }
    const first = manager.inventoryTable(request)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.data).toMatchObject({ total: 2, offset: 0, hasMore: true })
    expect(first.data.rows[0].values.name).toBe('Device 2')
    expect(first.data.propertyKeys).toContain('firmware')

    const hiddenSort = manager.inventoryTable({
      ...request,
      query: '',
      columns: ['name'],
      sortColumn: 'property:firmware',
      limit: 50,
    })
    expect(hiddenSort.ok).toBe(true)
    if (hiddenSort.ok) {
      expect(hiddenSort.data.rows.map(row => row.values)).toEqual([
        { name: 'Device 10' },
        { name: 'Device 2' },
      ])
    }

    const exported = manager.buildInventoryCsv(request)
    expect(exported.ok).toBe(true)
    if (!exported.ok) return
    expect(exported.data.rowCount).toBe(2)
    expect(exported.data.content).toContain('Name,Path,firmware')
    expect(exported.data.content.indexOf('Device 2')).toBeLessThan(exported.data.content.indexOf('Device 10'))
  })

  it('validates table requests at the IPC boundary', () => {
    expect(manager.inventoryTable({ query: '', filters: {}, columns: [], sortColumn: 'name' }))
      .toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(manager.inventoryTable({ query: '', filters: {}, columns: ['property:'], sortColumn: 'name' }))
      .toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(manager.inventoryTable({ query: '', filters: {}, columns: ['name'], sortColumn: 'property:' }))
      .toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(manager.inventoryTable({ query: '', filters: {}, columns: ['name'], sortColumn: 'name', sortDirection: 'sideways' }))
      .toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })

  it('exports every match beyond the renderer and search page limits', async () => {
    await manager.flushAndClose()
    const manyNodes = Array.from({ length: 205 }, (_, index) => ({
      id: `bulk-${index}`,
      parentId: 'root-id',
      name: `Bulk Device ${index + 1}`,
      order: index,
      properties: { serial: `SN-${index + 1}` },
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
    }))
    writeFixture(tmpDir, makeDocument({ nodes: [...makeDocument().nodes, ...manyNodes] }))
    search = new SearchIndexService()
    manager = makeManager(search)
    expect((await manager.openProject(tmpDir)).ok).toBe(true)

    const exported = manager.buildInventoryCsv({
      query: 'Bulk Device',
      filters: {},
      columns: ['name'],
      sortColumn: 'name',
      sortDirection: 'asc',
    })
    expect(exported.ok).toBe(true)
    if (!exported.ok) return
    expect(exported.data.rowCount).toBe(205)
    expect(exported.data.content).toContain('Bulk Device 205')
  })
})
