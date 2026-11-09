import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createHash, randomUUID } from 'crypto'
import { migrateSnapshotHistory, SnapshotHistoryVersionError, type SnapshotHistoryState } from '../shared/snapshot-history-migration'

/** A fully written temporary file is published with one rename. */
export function writeHistoryFile(path: string, data: string | Buffer): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx')
    writeFileSync(fd, data)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

export interface HistoryBackupCandidate {
  // Initially the metadata-file fingerprint. ProjectManager replaces this
  // with the preview fingerprint, which also covers Git and recovery files.
  token: string
  // Always the metadata-file fingerprint, rechecked by restore immediately
  // before replacing the primary file. Never compare it to the preview token.
  sourceToken: string
  savedAt: string
  history: SnapshotHistoryState
  damaged: Buffer | null
  // Exact validated source bytes used by the operation journal.
  source: Buffer
}

export class HistoryBackupStore {
  readonly historyPath: string
  readonly backupPath: string

  constructor(projectPath: string, private readonly projectId: string) {
    this.historyPath = join(projectPath, '.statekeep', 'history.json')
    this.backupPath = join(projectPath, '.statekeep', 'history.backup.json')
  }

  save(history: SnapshotHistoryState): void {
    migrateSnapshotHistory(history)
    writeHistoryFile(this.backupPath, JSON.stringify({
      version: 1, projectId: this.projectId, savedAt: new Date().toISOString(), history,
    }, null, 2))
  }

  candidate(): HistoryBackupCandidate {
    let damaged: Buffer | null = null
    try { damaged = readFileSync(this.historyPath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    let readable = false
    try {
      if (damaged !== null) {
        migrateSnapshotHistory(JSON.parse(damaged.toString('utf8')))
        readable = true
      }
    } catch (error) {
      if (error instanceof SnapshotHistoryVersionError) {
        throw new Error('Use a Statekeep version that supports this history format. Restoring an older backup could discard newer history.')
      }
    }
    if (readable) throw new Error('History metadata is readable. Backup restoration is only available for damaged metadata.')

    let bytes: Buffer
    try { bytes = readFileSync(this.backupPath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('No automatic history backup has been saved for this project. Restore history.json from a known-good external backup if available.')
      }
      throw error
    }
    const backup = JSON.parse(bytes.toString('utf8'))
    if (!backup || backup.version !== 1) throw new Error('The automatic backup format is invalid or unsupported.')
    if (backup.projectId !== this.projectId) throw new Error('The history backup belongs to another project.')
    if (typeof backup.savedAt !== 'string' || !Number.isFinite(Date.parse(backup.savedAt))) throw new Error('The backup save date is invalid.')
    const history = migrateSnapshotHistory(backup.history)
    const token = createHash('sha256').update(damaged === null ? 'missing:' : `${damaged.length}:`).update(damaged ?? Buffer.alloc(0)).update(bytes).digest('hex')
    return { token, sourceToken: token, savedAt: backup.savedAt, history, damaged, source: bytes }
  }

  restore(candidate: HistoryBackupCandidate, preservedPathOverride?: string): string | null {
    // Recheck both files immediately before preserving/replacing the original.
    if (this.candidate().token !== candidate.sourceToken) throw new Error('History files changed. Review the backup again before restoring.')
    const restored = migrateSnapshotHistory({
      ...candidate.history, currentBaseSnapshotId: null, pendingRevertEventId: null,
    })
    const preservedPath = candidate.damaged === null ? null : preservedPathOverride ?? `${this.historyPath}.damaged-${randomUUID()}`
    if (preservedPath && candidate.damaged !== null) {
      // An interrupted retry can leave this exclusive-create path behind. Such
      // an orphan is not used as evidence for another operation or restore.
      const fd = openSync(preservedPath, 'wx')
      try {
        writeFileSync(fd, candidate.damaged)
        fsyncSync(fd)
      } finally { closeSync(fd) }
    }
    // A backup may be older than the current inventory. Do not assert lineage
    // for the next snapshot based on metadata that was restored separately.
    writeHistoryFile(this.historyPath, JSON.stringify(restored, null, 2))
    return preservedPath
  }
}
