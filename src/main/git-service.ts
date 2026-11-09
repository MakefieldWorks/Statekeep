// Git service: all git CLI operations.
// Uses execFile (never exec) to prevent shell injection.
// Runs operations through a serial queue to prevent .git/index.lock contention.

import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { promisify } from 'util'
import type { GitStatus, Snapshot } from '../shared/types'
import type { Logger } from './logger'
import { PROJECT_DOCUMENT_FILE } from './project-document-file'

const execFileAsync = promisify(execFile)

// Node's default execFile stdout cap is 1 MB. A project document can be much
// larger (the project itself allows up to 50 MB), and `git show` / `for-each-ref`
// output scales with project and snapshot count — so reading a snapshot document
// for a large project would otherwise fail with ENOBUFS. Allow comfortably more.
const MAX_GIT_BUFFER = 64 * 1024 * 1024

const MIN_GIT_VERSION: [number, number, number] = [2, 25, 0]
const MIN_GIT_VERSION_STRING = MIN_GIT_VERSION.join('.')
const SNAPSHOT_TAG_PREFIX = 'snapshot/'
export class SnapshotDocumentChangedError extends Error {}

// Serial async queue — all git + file write operations enqueue here.
// Prevents .git/index.lock contention from concurrent operations.
class SerialQueue {
  private queue: Array<() => Promise<void>> = []
  private running = false

  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          resolve(await fn())
        } catch (e) {
          reject(e)
        }
      })
      this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift()!
        try {
          await task()
        } catch {
          // task() rejects its caller directly; keep draining later work.
        }
      }
    } finally {
      this.running = false
    }
  }
}

function parseVersion(output: string): [number, number, number] | null {
  const match = output.match(/git version (\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)]
}

function meetsMinimum(version: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] > MIN_GIT_VERSION[i]) return true
    if (version[i] < MIN_GIT_VERSION[i]) return false
  }
  return true
}

export class GitService {
  private readonly queue = new SerialQueue()

  constructor(private readonly logger: Logger) {}

  async archiveRefs(projectDir: string): Promise<string> {
    return this.queue.enqueue(async () => {
      const head = await archiveGit(projectDir, ['rev-parse', 'HEAD'])
      const tags = await archiveGit(projectDir, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/tags/snapshot/'])
      return `${head.trim()} HEAD\n${tags}`.trim()
    })
  }

  async createArchiveBundle(projectDir: string, destination: string): Promise<void> {
    await this.queue.enqueue(async () => {
      const tags = (await archiveGit(projectDir, ['for-each-ref', '--format=%(refname)', 'refs/tags/snapshot/'])).trim().split('\n').filter(Boolean)
      if (tags.length > 10000) throw new Error('Too many snapshots for one archive')
      await archiveGit(projectDir, ['bundle', 'create', destination, 'HEAD', '--tags=snapshot/*'])
    })
  }

  async restoreArchiveBundle(projectDir: string, bundle: string): Promise<void> {
    await this.queue.enqueue(async () => {
      // Start with fresh local configuration and no templates/hooks. Never
      // checkout a bundled tree: it may contain paths unrelated to Statekeep.
      await archiveGit(projectDir, ['init', '--template='])
      await archiveGit(projectDir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
      await archiveGit(projectDir, ['bundle', 'verify', bundle])
      const refs = (await archiveGit(projectDir, ['bundle', 'list-heads', bundle])).trim().split('\n')
      if (refs.length > 10001 || !refs.some(line => /^[0-9a-f]{40,64} HEAD$/.test(line))) throw new Error('Archive Git HEAD is missing or invalid')
      const names = new Set<string>()
      for (const line of refs) {
        const match = /^([0-9a-f]{40,64}) (HEAD|refs\/tags\/snapshot\/[^\s]+)$/.exec(line)
        if (!match || names.has(match[2])) throw new Error('Archive contains unsupported or duplicate Git references')
        names.add(match[2])
      }
      // Fixed-size refspecs avoid Windows command-line length limits for
      // projects with hundreds or thousands of named snapshots.
      const specs = ['HEAD:refs/heads/main']
      if (names.size > 1) specs.push('refs/tags/snapshot/*:refs/tags/snapshot/*')
      await archiveGit(projectDir, ['fetch', '--update-head-ok', '--no-tags', bundle, ...specs])
      const sizes = (await archiveGit(projectDir, ['cat-file', '--batch-all-objects', '--batch-check=%(objectsize) %(objectsize:disk)'])).trim().split('\n').map(line => line.split(' ').map(Number))
      if (sizes.length > 100000 || sizes.some(([expanded, stored]) => !Number.isFinite(expanded) || !Number.isFinite(stored) || expanded > MAX_GIT_BUFFER) ||
          sizes.reduce((sum, [, stored]) => sum + stored, 0) > 256 * 1024 * 1024) throw new Error('Archive Git history exceeds verification limits')
      await archiveGit(projectDir, ['fsck', '--full', '--strict'])
      await archiveGit(projectDir, ['read-tree', 'HEAD'])
    })
  }

  async checkVersion(): Promise<GitStatus> {
    try {
      const { stdout } = await execFileAsync('git', ['--version'])
      const parsed = parseVersion(stdout.trim())
      if (!parsed) {
        this.logger.warn('unrecognised git --version output', { stdout })
        return { available: true, version: stdout.trim(), meetsMinimum: false, minimumVersion: MIN_GIT_VERSION_STRING }
      }
      const meets = meetsMinimum(parsed)
      const version = parsed.join('.')
      this.logger.info('git version check', { version, meetsMinimum: meets })
      return { available: true, version, meetsMinimum: meets, minimumVersion: MIN_GIT_VERSION_STRING }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('git not found', { error: msg })
      return { available: false, version: null, meetsMinimum: false, minimumVersion: MIN_GIT_VERSION_STRING }
    }
  }

  async initRepo(projectDir: string): Promise<void> {
    await this.queue.enqueue(async () => {
      await execFileAsync('git', ['init'], { cwd: projectDir })
      this.logger.info('git init', { dir: projectDir })
    })
  }

  async initialCommit(projectDir: string): Promise<void> {
    await this.queue.enqueue(async () => {
      await execFileAsync('git', ['add', PROJECT_DOCUMENT_FILE], { cwd: projectDir })
      await execFileAsync(
        'git',
        ['-c', 'user.email=statekeep@local', '-c', 'user.name=Statekeep', 'commit', '-m', 'Initial project'],
        { cwd: projectDir }
      )
      this.logger.info('initial git commit', { dir: projectDir })
    })
  }

  async createSnapshot(projectDir: string, name: string, expectedDocumentHash?: string): Promise<Snapshot> {
    return this.queue.enqueue(async () => {
      await execFileAsync('git', ['add', PROJECT_DOCUMENT_FILE], { cwd: projectDir })
      if (expectedDocumentHash) {
        const { stdout } = await execFileAsync('git', ['show', `:${PROJECT_DOCUMENT_FILE}`], { cwd: projectDir, maxBuffer: MAX_GIT_BUFFER, encoding: 'buffer' })
        if (createHash('sha256').update(stdout).digest('hex') !== expectedDocumentHash) {
          await execFileAsync('git', ['reset', '-q', '--', PROJECT_DOCUMENT_FILE], { cwd: projectDir })
          throw new SnapshotDocumentChangedError('The staged project differs from the inventory Statekeep saved. Review the external change before snapshotting.')
        }
      }
      await execFileAsync(
        'git',
        ['-c', 'user.email=statekeep@local', '-c', 'user.name=Statekeep', 'commit', '--allow-empty', '-m', name],
        { cwd: projectDir }
      )
      await execFileAsync('git', ['tag', `${SNAPSHOT_TAG_PREFIX}${name}`], { cwd: projectDir })

      const snapshot = await this.readSnapshotUnchecked(projectDir, name)
      this.logger.info('snapshot created', { dir: projectDir, name, commitHash: snapshot.commitHash })
      return snapshot
    })
  }

  async listSnapshots(projectDir: string): Promise<Snapshot[]> {
    return this.queue.enqueue(async () => {
      const { stdout } = await execFileAsync(
        'git',
        [
          'for-each-ref',
          'refs/tags/snapshot',
          '--sort=-creatordate',
          '--format=%(refname)\t%(objectname)\t%(creatordate:iso-strict)\t%(subject)',
        ],
        { cwd: projectDir, maxBuffer: MAX_GIT_BUFFER }
      )

      const snapshots = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [refname, commitHash, createdAt, message] = line.split('\t')
          return {
            id: refname.replace(/^refs\/tags\/snapshot\//, ''),
            name: refname.replace(/^refs\/tags\/snapshot\//, ''),
            commitHash,
            createdAt,
            message,
            basedOnSnapshotId: null,
            createdAfterRevertEventId: null,
            note: null,
          }
        })

      this.logger.debug('snapshots listed', { dir: projectDir, count: snapshots.length })
      return snapshots
    })
  }

  async readSnapshotDocument(projectDir: string, name: string): Promise<string> {
    return this.queue.enqueue(async () => {
      return this.readProjectDocumentAt(projectDir, SNAPSHOT_TAG_PREFIX + name)
    })
  }

  async readHeadDocument(projectDir: string): Promise<string> {
    return this.queue.enqueue(async () => {
      return this.readProjectDocumentAt(projectDir, 'HEAD')
    })
  }

  private async readProjectDocumentAt(projectDir: string, ref: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['show', `${ref}:${PROJECT_DOCUMENT_FILE}`], {
      cwd: projectDir,
      maxBuffer: MAX_GIT_BUFFER,
    })
    return stdout
  }

  private async readSnapshotUnchecked(projectDir: string, name: string): Promise<Snapshot> {
    const { stdout } = await execFileAsync(
      'git',
      [
        'for-each-ref',
        `refs/tags/${SNAPSHOT_TAG_PREFIX}${name}`,
        '--format=%(refname)\t%(objectname)\t%(creatordate:iso-strict)\t%(subject)',
      ],
      { cwd: projectDir }
    )

    const line = stdout.trim()
    if (!line) {
      throw new Error(`Snapshot not found: ${name}`)
    }

    const [refname, commitHash, createdAt, message] = line.split('\t')
    const snapshotName = refname.replace(/^refs\/tags\/snapshot\//, '')
    return {
      id: snapshotName,
      name: snapshotName,
      commitHash,
      createdAt,
      message,
      basedOnSnapshotId: null,
      createdAfterRevertEventId: null,
      note: null,
    }
  }
}

async function archiveGit(cwd: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  env.GIT_TERMINAL_PROMPT = '0'
  const { stdout } = await execFileAsync('git', ['--no-replace-objects', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=always', ...args], {
    cwd, env, timeout: 60000, maxBuffer: MAX_GIT_BUFFER,
  })
  return stdout
}
