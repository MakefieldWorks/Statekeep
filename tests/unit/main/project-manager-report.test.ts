// Unit tests for diff-report export in ProjectManager. Stub git serves two
// snapshot documents so buildReport runs the real loadAndDiff + formatters.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { ProjectManager } from '../../../src/main/project-manager'
import { parseCsv } from '../../../src/shared/csv'

const noopLogger = { error() {}, warn() {}, info() {}, debug() {} }
const TS = '2026-01-01T00:00:00.000Z'

function document(nodes: unknown[], templates: Record<string, unknown> = {}) {
  return { version: 3, id: 'rep-id', name: 'Lab', created: TS, modified: TS, templates, nodes }
}
const before = document([
  { id: 'root', parentId: null, name: 'Lab', order: 0, properties: {}, created: TS, modified: TS },
  { id: 'b1', parentId: 'root', name: 'B1', order: 0, properties: { serial: 'SN-1' }, created: TS, modified: TS },
])
const after = document([
  { id: 'root', parentId: null, name: 'Lab', order: 0, properties: {}, created: TS, modified: TS },
  { id: 'b1', parentId: 'root', name: 'B1', order: 0, properties: { serial: 'SN-2' }, created: TS, modified: TS },
  { id: 'b2', parentId: 'root', name: 'B2', order: 1, properties: {}, created: TS, modified: TS },
])

const SNAPS = [
  { id: 's-before', name: 'before', commitHash: 'abc1234def0', createdAt: '2026-01-01T10:00:00.000Z', message: '', basedOnSnapshotId: null, createdAfterRevertEventId: null, note: null },
  { id: 's-after', name: 'after', commitHash: 'beef5678abc', createdAt: '2026-01-02T11:00:00.000Z', message: '', basedOnSnapshotId: null, createdAfterRevertEventId: null, note: null },
]

const HISTORY = {
  version: 1,
  currentBaseSnapshotId: 's-after',
  pendingRevertEventId: null,
  snapshots: {
    's-before': { id: 's-before', basedOnSnapshotId: null, createdAfterRevertEventId: null, note: 'Known-good baseline' },
    's-after': { id: 's-after', basedOnSnapshotId: 's-before', createdAfterRevertEventId: null, note: 'Validated upgrade' },
  },
  events: [],
  recoveryPoints: [],
}

function makeGit(over: Record<string, unknown> = {}) {
  return {
    checkVersion: async () => ({ available: true, version: '2.50.0', meetsMinimum: true, minimumVersion: '2.25' }),
    initRepo: async () => {},
    initialCommit: async () => {},
    run: async () => ({ stdout: '', stderr: '' }),
    listSnapshots: async () => SNAPS,
    readSnapshotDocument: async (_p: string, name: string) =>
      name === 'before' ? JSON.stringify(before) : JSON.stringify(after),
    ...over,
  }
}

let tmpDir: string
let manager: ProjectManager

async function open(git = makeGit()): Promise<void> {
  writeFileSync(join(tmpDir, 'Statekeep.statekeep'), JSON.stringify(after, null, 2), 'utf8')
  mkdirSync(join(tmpDir, '.statekeep'), { recursive: true })
  writeFileSync(join(tmpDir, '.statekeep', 'history.json'), JSON.stringify(HISTORY, null, 2), 'utf8')
  manager = new ProjectManager(git as any, noopLogger as any)
  const r = await manager.openProject(tmpDir)
  expect(r.ok).toBe(true)
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `statekeep-report-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
})
afterEach(async () => {
  manager?.cancelAutosave()
  await manager?.flushAndClose()
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

describe('buildReport', () => {
  it('errors when no project is open', async () => {
    const pm = new ProjectManager(makeGit() as any, noopLogger as any)
    const r = await pm.buildReport('before', 'after', 'markdown')
    expect(r.ok).toBe(false)
  })

  it('builds a Markdown report with header, summary, and the actual changes', async () => {
    await open()
    const r = await manager.buildReport('before', 'after', 'markdown')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const { content, suggestedName } = r.data
    expect(content).toContain('# Change Report: Lab')
    expect(content).toContain('**From:** before (2026-01-01 10:00 · abc1234)')
    expect(content).toContain('**From description:** Known-good baseline')
    expect(content).toContain('**To:** after (2026-01-02 11:00 · beef567)')
    expect(content).toContain('**To description:** Validated upgrade')
    expect(content).toContain('## Added (1)')
    expect(content).toContain('- Lab / B2')
    expect(content).toContain('## Property changes (1 node(s))')
    expect(content).toContain('serial: SN-1 → SN-2')
    expect(suggestedName).toBe('Lab-changes-before-to-after.md')
  })

  it('builds a CSV report (node changes, property expanded per key)', async () => {
    await open()
    const r = await manager.buildReport('before', 'after', 'csv')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const rows = parseCsv(r.data.content)
    expect(rows[0]).toEqual(['path', 'node', 'change', 'severity', 'property', 'old', 'new', 'removed_descendants', 'broken_references', 'from_description', 'to_description', 'scope'])
    expect(rows).toContainEqual(['Lab', 'B2', 'added', 'High', '', '', '', '', '', 'Known-good baseline', 'Validated upgrade', ''])
    expect(rows).toContainEqual(['Lab', 'B1', 'property-changed', 'Medium', 'serial', 'SN-1', 'SN-2', '', '', 'Known-good baseline', 'Validated upgrade', ''])
    expect(r.data.suggestedName).toBe('Lab-changes-before-to-after.csv')
  })

  it('builds a self-contained HTML review', async () => {
    await open()
    const r = await manager.buildReport('before', 'after', 'html')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.content).toMatch(/^<!doctype html>/)
    expect(r.data.content).toContain('Statekeep change review')
    expect(r.data.content).toContain('Known-good baseline')
    expect(r.data.content).toContain('B2')
    expect(r.data.suggestedName).toBe('Lab-changes-before-to-after.html')
  })

  it('rejects an unsupported report format', async () => {
    await open()
    const r = await manager.buildReport('before', 'after', 'pdf')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('VALIDATION_FAILED')
  })

  it('returns an error when a snapshot document is unreadable', async () => {
    await open(makeGit({ readSnapshotDocument: async () => { throw new Error('bad object') } }))
    const r = await manager.buildReport('before', 'after', 'markdown')
    expect(r.ok).toBe(false)
  })
})
