import { createHash } from 'crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { Project, ProjectArchivePreview } from '../shared/types'
import { migrateSnapshotHistory } from '../shared/snapshot-history-migration'
import { PROJECT_DOCUMENT_FILE } from './project-document-file'
import { GitService } from './git-service'
import { writeHistoryFile } from './history-backup'

const MAX_BYTES = 128 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 180 * 1024 * 1024
const MAX_FILES = 2000
type Entry = { path: string; sha256: string; data: string }
type Archive = { format: 'statekeep-project-archive'; version: 1; createdAt: string; entries: Entry[] }
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

function allowedPath(path: string): boolean {
  if (path.split('/').some(part => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part) || part.length > 240)) return false
  return path === PROJECT_DOCUMENT_FILE || path === 'snapshots.bundle' ||
    path === '.statekeep/history.json' || path === '.statekeep/history.backup.json' ||
    /^\.statekeep\/history\.json\.damaged-[a-zA-Z0-9-]+$/.test(path) ||
    (/^\.statekeep\/recovery\/[^/\\:]+$/.test(path) && !path.includes('..') && !/[\x00-\x1f]/.test(path))
}

function readBounded(path: string, max = MAX_BYTES): Buffer {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error(`Unsupported or oversized archive input: ${path}`)
  const bytes = readFileSync(path)
  if (bytes.length > max) throw new Error('Archive input grew beyond its size limit')
  return bytes
}

// Git marks its object files read-only. On Windows, Electron 44's Node 24
// fs.rmSync fails on them with EPERM (Node 22's did not), which left archive
// export stuck after a successful write. fs.promises.rm still removes them.
async function removeGitFolder(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

export class ProjectArchive {
  constructor(private readonly git: GitService, private readonly parseProject: (raw: string) => Project) {}

  private sourceFiles(projectPath: string): Map<string, Buffer> {
    const files = new Map<string, Buffer>()
    const directory = join(projectPath, '.statekeep')
    if (!existsSync(directory)) return files
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Linked metadata directories cannot be archived')
    for (const name of readdirSync(directory).sort()) {
      if (name === 'recovery') {
        const recovery = join(directory, name)
        if (!lstatSync(recovery).isDirectory() || lstatSync(recovery).isSymbolicLink()) throw new Error('Linked recovery directories cannot be archived')
        for (const file of readdirSync(recovery).sort()) {
          const key = `.statekeep/recovery/${file}`
          if (!allowedPath(key)) throw new Error(`Unsupported recovery filename: ${file}`)
          files.set(key, readBounded(join(recovery, file)))
          this.checkSize(files)
        }
      } else if (name === 'history.json' || name === 'history.backup.json' || name.startsWith('history.json.damaged-')) {
        const key = `.statekeep/${name}`
        if (!allowedPath(key)) throw new Error(`Unsupported history filename: ${name}`)
        files.set(key, readBounded(join(directory, name)))
        this.checkSize(files)
      }
    }
    return files
  }

  private checkSize(files: Map<string, Buffer>) {
    if (files.size > MAX_FILES || [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0) > MAX_BYTES) throw new Error('Archive exceeds the 128 MB / 2,000-file limit')
  }

  private fingerprint(files: Map<string, Buffer>): string {
    return digest(JSON.stringify([...files].map(([path, bytes]) => [path, digest(bytes)])))
  }

  async export(projectPath: string, currentDocument: string, destination: string): Promise<void> {
    const files = this.sourceFiles(projectPath)
    const sourceToken = this.fingerprint(files)
    const refs = await this.git.archiveRefs(projectPath)
    const scratch = mkdtempSync(join(tmpdir(), 'statekeep-archive-'))
    try {
      const bundle = join(scratch, 'snapshots.bundle')
      await this.git.createArchiveBundle(projectPath, bundle)
      if (refs !== await this.git.archiveRefs(projectPath) || sourceToken !== this.fingerprint(this.sourceFiles(projectPath))) {
        throw new Error('Project history changed while archiving. Try exporting again.')
      }
      files.set(PROJECT_DOCUMENT_FILE, Buffer.from(currentDocument))
      files.set('snapshots.bundle', readBounded(bundle))
      this.checkSize(files)
      const archive: Archive = { format: 'statekeep-project-archive', version: 1, createdAt: new Date().toISOString(),
        entries: [...files].map(([path, bytes]) => ({ path, sha256: digest(bytes), data: bytes.toString('base64') })) }
      const output = JSON.stringify(archive)
      if (Buffer.byteLength(output) > MAX_ARCHIVE_BYTES) throw new Error('Encoded archive exceeds its size limit')
      const candidatePath = join(scratch, 'candidate.statekeeparchive')
      writeFileSync(candidatePath, output, { flag: 'wx' })
      // Verify the encoded container and an isolated reconstruction before
      // publishing, using exactly the same decoder as an imported archive.
      const decoded = this.decode(candidatePath)
      const staged = join(scratch, 'verify')
      mkdirSync(staged)
      await this.materialize(decoded.files, staged)
      if (refs !== await this.git.archiveRefs(staged)) throw new Error('Reconstructed Git references differ from the source')
      writeHistoryFile(destination, output)
    } finally { await removeGitFolder(scratch) }
  }

  private decode(path: string): { archive: Archive; files: Map<string, Buffer>; token: string } {
    const bytes = readBounded(path, MAX_ARCHIVE_BYTES)
    const archive = JSON.parse(bytes.toString('utf8')) as Archive
    if (!archive || archive.format !== 'statekeep-project-archive' || archive.version !== 1 ||
        typeof archive.createdAt !== 'string' || !Number.isFinite(Date.parse(archive.createdAt)) ||
        !Array.isArray(archive.entries) || archive.entries.length > MAX_FILES) throw new Error('Invalid or unsupported project archive')
    const files = new Map<string, Buffer>()
    const names = new Set<string>()
    for (const entry of archive.entries) {
      if (!entry || typeof entry.path !== 'string' || !allowedPath(entry.path) || names.has(entry.path.toLowerCase()) ||
          typeof entry.data !== 'string' || typeof entry.sha256 !== 'string') throw new Error('Invalid, duplicate, or unsafe archive path')
      const content = Buffer.from(entry.data, 'base64')
      if (content.toString('base64') !== entry.data || digest(content) !== entry.sha256) throw new Error(`Archive integrity check failed: ${entry.path}`)
      files.set(entry.path, content)
      names.add(entry.path.toLowerCase())
      this.checkSize(files)
    }
    if (!files.has(PROJECT_DOCUMENT_FILE) || !files.has('snapshots.bundle')) throw new Error('Archive is missing current inventory or snapshot history')
    return { archive, files, token: digest(bytes) }
  }

  private async materialize(files: Map<string, Buffer>, destination: string): Promise<{ project: Project; snapshotCount: number }> {
    const document = files.get(PROJECT_DOCUMENT_FILE)!
    if (document.length > 50 * 1024 * 1024) throw new Error('Current inventory exceeds the 50 MB project limit')
    const project = this.parseProject(document.toString('utf8'))
    for (const [path, bytes] of files) {
      mkdirSync(dirname(join(destination, path)), { recursive: true })
      writeFileSync(join(destination, path), bytes, { flag: 'wx' })
    }
    const bundle = join(destination, 'snapshots.bundle')
    await this.git.restoreArchiveBundle(destination, bundle)
    rmSync(bundle)
    const snapshots = await this.git.listSnapshots(destination)
    const snapshotIds = new Set(snapshots.map(snapshot => snapshot.id))
    // Validate all snapshot documents, not only Git object integrity.
    const head = this.parseProject(await this.git.readHeadDocument(destination))
    if (head.id !== project.id) throw new Error('Archive HEAD belongs to another project')
    for (const snapshot of snapshots) {
      const saved = this.parseProject(await this.git.readSnapshotDocument(destination, snapshot.id))
      if (saved.id !== project.id) throw new Error(`Snapshot belongs to another project: ${snapshot.id}`)
    }
    const historyBytes = files.get('.statekeep/history.json')
    if (!historyBytes && files.has('.statekeep/history.backup.json')) throw new Error('Restore missing history metadata from its backup before exporting an archive')
    if (historyBytes) {
      const history = migrateSnapshotHistory(JSON.parse(historyBytes.toString('utf8')))
      const refs = [...Object.keys(history.snapshots), ...Object.values(history.snapshots).map(meta => meta.basedOnSnapshotId),
        ...history.events.flatMap(event => [event.snapshotId, event.targetSnapshotId]), history.currentBaseSnapshotId].filter(Boolean)
      if (refs.some(ref => !snapshotIds.has(ref!))) throw new Error('History metadata references unavailable snapshots')
      for (const point of history.recoveryPoints) {
        const payload = files.get(point.payloadPath.replaceAll('\\', '/'))
        if (!payload || this.parseProject(payload.toString('utf8')).id !== project.id) throw new Error(`Recovery payload is missing or invalid: ${point.id}`)
      }
    }
    for (const [path, bytes] of files) {
      if (path !== 'snapshots.bundle' && digest(readBounded(join(destination, path))) !== digest(bytes)) throw new Error(`Restored file verification failed: ${path}`)
    }
    return { project, snapshotCount: snapshots.length }
  }

  async inspect(path: string): Promise<ProjectArchivePreview> {
    const { archive, files, token } = this.decode(path)
    const scratch = mkdtempSync(join(tmpdir(), 'statekeep-archive-review-'))
    try {
      const result = await this.materialize(files, scratch)
      return { token, projectName: result.project.name, createdAt: archive.createdAt, snapshotCount: result.snapshotCount,
        recoveryFileCount: [...files.keys()].filter(path => path.startsWith('.statekeep/recovery/')).length, fileCount: files.size }
    } finally { await removeGitFolder(scratch) }
  }

  async restore(path: string, token: string, parent: string): Promise<string> {
    const { files, token: actualToken } = this.decode(path)
    if (token !== actualToken) throw new Error('Archive changed. Review it again before restoring.')
    // mkdtemp atomically reserves a new folder. No existing destination can be
    // overwritten, and failures remove only the folder this operation created.
    const destination = mkdtempSync(join(parent, 'Statekeep-restored-'))
    try {
      await this.materialize(files, destination)
      return destination
    } catch (error) {
      await removeGitFolder(destination)
      throw error
    }
  }
}
