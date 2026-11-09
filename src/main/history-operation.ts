import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import { createHash, randomUUID } from 'crypto'
import { writeHistoryFile } from './history-backup'

const LIMIT = 50 * 1024 * 1024
interface PendingHistoryOperationBase {
  id: string
  projectId: string
  label: string
  startedAt: string
  inventoryFile: string
  historyFile: string
  inventoryHash: string
  historyHash: string
}

export interface PendingHistoryOperationV1 extends PendingHistoryOperationBase {
  version: 1
}

export type HistoryOperationKind = 'snapshot-create' | 'snapshot-revert' | 'recovery-apply'

export interface HistoryOperationIntent {
  kind: HistoryOperationKind
  eventId: string
  targetId: string
  expectedDocumentHash: string
}

export interface PendingHistoryOperationV2 extends PendingHistoryOperationBase, HistoryOperationIntent {
  version: 2
}

export type MetadataHistoryOperationKind = 'recovery-register' | 'recovery-forget' | 'history-backup-restore'

export interface MetadataHistoryOperationIntent {
  kind: MetadataHistoryOperationKind
  targetId: string
  expectedDocumentHash: string
  expectedHistoryHash: string
  targetPayloadHash?: string
}

export interface PendingHistoryOperationV3 extends PendingHistoryOperationBase, MetadataHistoryOperationIntent {
  version: 3
  historyMissing: boolean
  sourceFile?: string
  sourceHash?: string
}

export type PendingHistoryOperation = PendingHistoryOperationV1 | PendingHistoryOperationV2 | PendingHistoryOperationV3

export interface RetainedHistoryOperationCandidate {
  record: PendingHistoryOperation
  recordFile: string
  recordPath: string
  bytes: Buffer
  inventory: Buffer
  history: Buffer
  source: Buffer | null
}

export class RetainedEvidenceChangedError extends Error {}

/** Durable evidence, not a transaction or a request to replay Git commands. */
export class HistoryOperationStore {
  readonly pendingPath: string
  readonly recoveryPath: string
  constructor(private readonly projectPath: string, private readonly projectId: string) {
    this.pendingPath = join(projectPath, '.statekeep', 'history-operation.json')
    this.recoveryPath = join(projectPath, '.statekeep', 'recovery')
  }

  pending(): boolean {
    try { lstatSync(this.pendingPath); return true } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      // Unreadable evidence is still pending; never silently unblock writes.
      return true
    }
  }

  private directories(create = false): void {
    for (const path of [this.projectPath, join(this.projectPath, '.statekeep'), this.recoveryPath]) {
      if (!existsSync(path)) {
        if (!create || path === this.projectPath) throw new Error('An operation evidence folder is missing.')
        mkdirSync(path)
      }
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Operation evidence requires regular local directories.')
    }
  }

  read(path: string): Buffer {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMIT) throw new Error('Operation evidence must be a regular file under 50 MB.')
    const bytes = readFileSync(path)
    if (bytes.length > LIMIT) throw new Error('Operation evidence exceeds 50 MB.')
    return bytes
  }

  private candidateAt(recordPath: string, retainedId?: string): RetainedHistoryOperationCandidate {
    this.directories()
    const bytes = this.read(recordPath)
    const record = JSON.parse(bytes.toString('utf8')) as PendingHistoryOperation
    if ((record.version !== 1 && record.version !== 2 && record.version !== 3) || record.projectId !== this.projectId ||
        typeof record.id !== 'string' || !/^[0-9a-f-]{36}$/.test(record.id) ||
        (retainedId !== undefined && record.id !== retainedId) ||
        typeof record.label !== 'string' || record.label.length > 300 ||
        typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt)) ||
        record.inventoryFile !== `recovery-${record.id}-before.document.json` ||
        record.historyFile !== `recovery-${record.id}-history.json` ||
        (record.version === 2 && (!['snapshot-create', 'snapshot-revert', 'recovery-apply'].includes(record.kind) ||
          typeof record.eventId !== 'string' || !/^[0-9a-f-]{36}$/.test(record.eventId) ||
          typeof record.targetId !== 'string' || record.targetId.length === 0 || record.targetId.length > 2000 ||
          typeof record.expectedDocumentHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.expectedDocumentHash))) ||
        (record.version === 3 && (!['recovery-register', 'recovery-forget', 'history-backup-restore'].includes(record.kind) ||
          typeof record.targetId !== 'string' || record.targetId.length === 0 || record.targetId.length > 2000 ||
          !/^[0-9a-f]{64}$/.test(record.expectedDocumentHash) || !/^[0-9a-f]{64}$/.test(record.expectedHistoryHash) ||
          typeof record.historyMissing !== 'boolean' ||
          (record.kind === 'recovery-register' ? !/^[0-9a-f]{64}$/.test(record.targetPayloadHash ?? '') :
            record.targetPayloadHash !== undefined) ||
          (record.kind === 'history-backup-restore' ?
            record.sourceFile !== `recovery-${record.id}-source-history-backup.json` || !/^[0-9a-f]{64}$/.test(record.sourceHash ?? '') :
            record.sourceFile !== undefined || record.sourceHash !== undefined)))) {
      throw new Error('Unsupported or invalid operation record. Preserve it for manual recovery.')
    }
    const inventory = this.read(join(this.recoveryPath, record.inventoryFile))
    const history = this.read(join(this.recoveryPath, record.historyFile))
    if (record.inventoryHash !== this.fingerprint(inventory) || record.historyHash !== this.fingerprint(history)) throw new Error('Preserved operation evidence has changed. Keep the files for manual recovery.')
    if (record.version === 3 && record.historyMissing && history.length !== 0) throw new Error('Missing-history evidence has changed.')
    const source = record.version === 3 && record.sourceFile ? this.read(join(this.recoveryPath, record.sourceFile)) : null
    if (record.version === 3 && source && this.fingerprint(source) !== record.sourceHash) throw new Error('Preserved backup evidence has changed.')
    return { record, recordFile: recordPath === this.pendingPath ? 'history-operation.json' : `recovery-${record.id}-operation.json`,
      recordPath, bytes, inventory, history, source }
  }

  candidate(): RetainedHistoryOperationCandidate {
    return this.candidateAt(this.pendingPath)
  }

  retainedCandidates(limit = 100): { candidates: RetainedHistoryOperationCandidate[]; unavailableCount: number; uninspectedCount: number } {
    this.directories()
    const recordFiles: { name: string; modified: number }[] = []
    let unavailableCount = 0
    for (const name of readdirSync(this.recoveryPath)) {
      if (!/^recovery-([0-9a-f-]{36})-operation\.json$/.test(name)) continue
      try { recordFiles.push({ name, modified: lstatSync(join(this.recoveryPath, name)).mtimeMs }) }
      catch { unavailableCount++ }
    }
    recordFiles.sort((a, b) => b.modified - a.modified || b.name.localeCompare(a.name))
    const candidates: RetainedHistoryOperationCandidate[] = []
    for (const { name: recordFile } of recordFiles.slice(0, limit)) {
      const id = /^recovery-([0-9a-f-]{36})-operation\.json$/.exec(recordFile)![1]
      try { candidates.push(this.candidateAt(join(this.recoveryPath, recordFile), id)) }
      catch { unavailableCount++ }
    }
    return { candidates, unavailableCount, uninspectedCount: Math.max(0, recordFiles.length - limit) }
  }

  removeRetained(candidate: RetainedHistoryOperationCandidate, remove: typeof unlinkSync = unlinkSync): { deletedFiles: string[]; remainingFiles: string[] } {
    let current: RetainedHistoryOperationCandidate
    try { current = this.candidateAt(candidate.recordPath, candidate.record.id) }
    catch { throw new RetainedEvidenceChangedError('Operation evidence changed. Review it again before deleting.') }
    if (!current.bytes.equals(candidate.bytes) || !current.inventory.equals(candidate.inventory) || !current.history.equals(candidate.history) ||
        (current.source === null) !== (candidate.source === null) || (current.source !== null && !current.source.equals(candidate.source!))) {
      throw new RetainedEvidenceChangedError('Operation evidence changed. Review it again before deleting.')
    }
    // Remove the index record first. If either payload unlink fails, the
    // remaining file stays as ordinary recovery material and is never shown as
    // a complete evidence group.
    remove(candidate.recordPath)
    const deletedFiles = [candidate.recordFile]
    const remainingFiles: string[] = []
    for (const file of [candidate.record.inventoryFile, candidate.record.historyFile,
      candidate.record.version === 3 ? candidate.record.sourceFile : undefined].filter((file): file is string => !!file)) {
      let removed = false
      try { remove(join(this.recoveryPath, file)); removed = true }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') removed = true
        else remainingFiles.push(file)
      }
      if (removed) deletedFiles.push(file)
    }
    return { deletedFiles, remainingFiles }
  }

  begin(label: string, inventory: string, history: string, intent?: HistoryOperationIntent): void {
    this.directories(true)
    if (this.pending()) throw new Error('Review the unfinished history operation first.')
    if (Buffer.byteLength(inventory) > LIMIT || Buffer.byteLength(history) > LIMIT || label.length > 300) throw new Error('Operation evidence exceeds supported limits.')
    const id = randomUUID()
    const base: PendingHistoryOperationBase = { id, projectId: this.projectId, label,
      startedAt: new Date().toISOString(), inventoryFile: `recovery-${id}-before.document.json`, historyFile: `recovery-${id}-history.json`,
      inventoryHash: this.fingerprint(inventory), historyHash: this.fingerprint(history) }
    const record: PendingHistoryOperation = intent ? { ...base, version: 2, ...intent } : { ...base, version: 1 }
    writeHistoryFile(join(this.recoveryPath, record.inventoryFile), inventory)
    writeHistoryFile(join(this.recoveryPath, record.historyFile), history)
    // Published only after both before-state copies have been flushed.
    writeHistoryFile(this.pendingPath, JSON.stringify(record, null, 2))
  }

  beginMetadata(label: string, inventory: string, history: Buffer | null, intent: MetadataHistoryOperationIntent,
    source: Buffer | null = null): PendingHistoryOperationV3 {
    this.directories(true)
    if (this.pending()) throw new Error('Review the unfinished history operation first.')
    if (Buffer.byteLength(inventory) > LIMIT || (history?.length ?? 0) > LIMIT || (source?.length ?? 0) > LIMIT || label.length > 300) {
      throw new Error('Operation evidence exceeds supported limits.')
    }
    if (!['recovery-register', 'recovery-forget', 'history-backup-restore'].includes(intent.kind) ||
        !intent.targetId || intent.targetId.length > 2000 ||
        !/^[0-9a-f]{64}$/.test(intent.expectedDocumentHash) || !/^[0-9a-f]{64}$/.test(intent.expectedHistoryHash) ||
        (intent.kind === 'recovery-register' ? !/^[0-9a-f]{64}$/.test(intent.targetPayloadHash ?? '') :
          intent.targetPayloadHash !== undefined) ||
        (intent.kind === 'history-backup-restore' ? source === null : source !== null || history === null)) {
      throw new Error('Invalid metadata operation intent. No journal was published.')
    }
    const id = randomUUID()
    const record: PendingHistoryOperationV3 = {
      id, projectId: this.projectId, label, startedAt: new Date().toISOString(), version: 3,
      inventoryFile: `recovery-${id}-before.document.json`, historyFile: `recovery-${id}-history.json`,
      inventoryHash: this.fingerprint(inventory), historyHash: this.fingerprint(history ?? Buffer.alloc(0)),
      historyMissing: history === null, ...intent,
      ...(source === null ? {} : { sourceFile: `recovery-${id}-source-history-backup.json`, sourceHash: this.fingerprint(source) }),
    }
    writeHistoryFile(join(this.recoveryPath, record.inventoryFile), inventory)
    writeHistoryFile(join(this.recoveryPath, record.historyFile), history ?? Buffer.alloc(0))
    if (record.sourceFile && source) writeHistoryFile(join(this.recoveryPath, record.sourceFile), source)
    writeHistoryFile(this.pendingPath, JSON.stringify(record, null, 2))
    return record
  }

  finish(preserve = false): void {
    const { record } = this.candidate()
    if (preserve) {
      renameSync(this.pendingPath, join(this.recoveryPath, `recovery-${record.id}-operation.json`))
    } else {
      unlinkSync(this.pendingPath)
      // A crash during cleanup leaves unlisted copies, not a pending operation.
      for (const file of [record.inventoryFile, record.historyFile, record.version === 3 ? record.sourceFile : undefined]) {
        if (!file) continue
        try { unlinkSync(join(this.recoveryPath, file)) } catch { /* Harmless retained evidence. */ }
      }
    }
  }

  fingerprint(...bytes: (Buffer | string)[]): string {
    return createHash('sha256').update(JSON.stringify(bytes.map(value => createHash('sha256').update(value).digest('hex')))).digest('hex')
  }
}
