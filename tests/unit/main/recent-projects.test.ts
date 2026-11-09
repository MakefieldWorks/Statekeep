import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { RecentProjectsStore, getRecentDocumentPath } from '../../../src/main/recent-projects'
import { PROJECT_DOCUMENT_FILE } from '../../../src/main/project-document-file'
import type { Project } from '../../../src/shared/types'

let tmpDir: string

beforeEach(() => {
  tmpDir = join(tmpdir(), `statekeep-recent-projects-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-01T12:00:00.000Z'))
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

function project(path: string, name = 'Lab'): Project {
  return {
    version: 1,
    id: name,
    name,
    created: '2026-07-01T00:00:00.000Z',
    modified: '2026-07-01T00:00:00.000Z',
    nodes: [],
    path,
  }
}

function writeProjectDir(name: string): string {
  const projectDir = join(tmpDir, name)
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'Statekeep.statekeep'), '{}', 'utf8')
  return projectDir
}

describe('RecentProjectsStore', () => {
  it('adds most recently opened projects first and persists them', () => {
    const storePath = join(tmpDir, 'recent-projects.json')
    const first = writeProjectDir('First')
    const second = writeProjectDir('Second')

    const store = new RecentProjectsStore(storePath)
    store.add(project(first, 'First'))
    store.add(project(second, 'Second'))

    const reloaded = new RecentProjectsStore(storePath)
    expect(reloaded.all().map(entry => entry.name)).toEqual(['Second', 'First'])
    expect(reloaded.all().every(entry => entry.exists)).toBe(true)
  })

  it('deduplicates reopened projects and caps the list', () => {
    const store = new RecentProjectsStore(join(tmpDir, 'recent-projects.json'))
    const paths = Array.from({ length: 11 }, (_, index) => writeProjectDir(`Project ${index}`))

    for (const [index, path] of paths.entries()) {
      store.add(project(path, `Project ${index}`))
    }
    store.add(project(paths[0]!, 'Project 0'))

    const entries = store.all()
    expect(entries).toHaveLength(10)
    expect(entries[0]!.name).toBe('Project 0')
    expect(entries.filter(entry => entry.path === paths[0])).toHaveLength(1)
  })

  it('marks projects without a document as missing', () => {
    const store = new RecentProjectsStore(join(tmpDir, 'recent-projects.json'))
    const projectDir = join(tmpDir, 'Deleted')

    store.add(project(projectDir, 'Deleted'))

    expect(store.all()[0]).toMatchObject({ name: 'Deleted', exists: false })
  })

  it('clears persisted projects', () => {
    const storePath = join(tmpDir, 'recent-projects.json')
    const store = new RecentProjectsStore(storePath)
    store.add(project(writeProjectDir('Lab')))

    store.clear()

    expect(new RecentProjectsStore(storePath).all()).toEqual([])
  })

  it('keeps recent tracking best-effort when persistence fails', () => {
    const store = new RecentProjectsStore('/dev/null/recent-projects.json')
    const projectDir = writeProjectDir('Best Effort')

    expect(() => store.add(project(projectDir, 'Best Effort'))).not.toThrow()
    expect(store.all()[0]).toMatchObject({
      name: 'Best Effort',
      path: projectDir,
      exists: true,
    })
  })
})

describe('getRecentDocumentPath', () => {
  it('returns the dedicated project document for OS recent documents', () => {
    const projectDir = writeProjectDir('DocumentOnly')

    expect(getRecentDocumentPath(projectDir)).toBe(join(projectDir, PROJECT_DOCUMENT_FILE))
  })

  it('returns null when no stable project document exists', () => {
    const projectDir = join(tmpDir, 'Missing')

    expect(getRecentDocumentPath(projectDir)).toBeNull()
  })
})
