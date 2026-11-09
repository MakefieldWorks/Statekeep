// Snapshot history metadata (.statekeep/history.json): read, write, and the
// pure timeline helpers built on it. Reads never repair or overwrite damaged
// metadata; they throw HistoryMetadataReadError so callers block history
// operations and the user can restore from the automatic backup.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { v7 as uuidv7 } from 'uuid'
import type { Project, RecoveryPoint, Snapshot, SnapshotTimelineEvent } from '../../shared/types'
import {
  emptySnapshotHistory,
  migrateSnapshotHistory,
  type SnapshotHistoryState,
} from '../../shared/snapshot-history-migration'
import { HistoryBackupStore, writeHistoryFile } from '../history-backup'
import type { GitService } from '../git-service'
import type { Logger } from '../logger'
import { canonicalizeDocumentJson, serializeProjectForPersistence } from './document'

const MAX_RECOVERY_POINTS = 10                 // cap stored auto-saved recovery points

export class HistoryMetadataReadError extends Error {}

export function snapshotHistoryPath(projectPath: string): string {
  return join(projectPath, '.statekeep', 'history.json')
}

// Parse history metadata from `bytes` when given (callers that already hold
// the exact bytes they verified), otherwise from disk.
export function readSnapshotHistoryFile(projectPath: string, projectId: string, logger: Logger, bytes?: Buffer): SnapshotHistoryState {
  const historyPath = snapshotHistoryPath(projectPath)
  try {
    const parsed = JSON.parse(bytes ? bytes.toString('utf8') : readFileSync(historyPath, 'utf8'))
    return migrateSnapshotHistory(parsed)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      if (!existsSync(new HistoryBackupStore(projectPath, projectId).backupPath)) return emptySnapshotHistory()
      throw new HistoryMetadataReadError('History metadata is missing, but an automatic backup exists. Review and restore the backup before creating snapshots, reverting, or recovering.')
    }
    const msg = e instanceof Error ? e.message : String(e)
    logger.warn('snapshot history unavailable; preserving original metadata', { path: historyPath, error: msg })
    throw new HistoryMetadataReadError(
      `History metadata could not be read. The original file is preserved at ${historyPath}. ` +
      'Restore this file from a known-good backup, or open the project with a Statekeep version that supports it, then refresh. ' +
      `Snapshot creation, revert, and recovery are blocked until it can be read. Details: ${msg}`
    )
  }
}

// Write primary metadata, refresh the automatic backup, then delete payload
// files for recovery points that `previous` had and `history` dropped.
export function writeSnapshotHistoryFile(
  projectPath: string,
  projectId: string,
  history: SnapshotHistoryState,
  previous: SnapshotHistoryState,
  deleteRemovedPayloads: boolean,
  logger: Logger,
): void {
  const metadataDirectory = join(projectPath, '.statekeep')
  const historyPath = snapshotHistoryPath(projectPath)
  mkdirSync(metadataDirectory, { recursive: true })
  writeHistoryFile(historyPath, JSON.stringify(history, null, 2))
  try {
    new HistoryBackupStore(projectPath, projectId).save(history)
  } catch (error) {
    // Primary metadata has committed. Keep the pre-operation backup and its
    // payloads, and do not report an already-completed operation as failed.
    logger.warn('history backup refresh failed; previous backup retained', { error: String(error) })
    return
  }
  // Forgetting a registration removes it from the retained set, but must
  // keep its file. Automatic retention pruning explicitly permits deletion.
  if (!deleteRemovedPayloads) return
  const retained = new Set(history.recoveryPoints.map(point => point.payloadPath))
  for (const point of previous.recoveryPoints) {
    if (retained.has(point.payloadPath)) continue
    try { unlinkSync(join(projectPath, ...point.payloadPath.split(/[\\/]/))) } catch (error) {
      logger.warn('recovery point file delete failed', { id: point.id, error: String(error) })
    }
  }
}

// Select retained entries. Physical deletion happens only after primary
// metadata and its automatic backup both contain the retained registry.
export function pruneRecoveryPoints(history: SnapshotHistoryState, protectedId: string | null = null): void {
  const automatic = history.recoveryPoints.filter(point => point.reason !== 'reconciled')
  if (automatic.length <= MAX_RECOVERY_POINTS) return

  const sorted = automatic.filter(point => point.id !== protectedId).sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  )
  const removeCount = automatic.length - MAX_RECOVERY_POINTS
  const toRemove = sorted.slice(0, removeCount)
  const removeIds = new Set(toRemove.map(p => p.id))

  history.recoveryPoints = history.recoveryPoints.filter(p => !removeIds.has(p.id))
}

export function withSnapshotMetadata(snapshots: Snapshot[], history: SnapshotHistoryState): Snapshot[] {
  return snapshots.map(snapshot => {
    const meta = history.snapshots[snapshot.id]
    return {
      ...snapshot,
      basedOnSnapshotId: meta?.basedOnSnapshotId ?? null,
      createdAfterRevertEventId: meta?.createdAfterRevertEventId ?? null,
      note: meta?.note ?? null,
    }
  })
}

// Snapshot events for git tags that history.events never recorded (projects
// that pre-date timeline tracking, or scripts that bypassed snapshotCreate),
// sorted by createdAt. Callers prepend these to the recorded events.
export function synthesizeSnapshotEvents(
  snapshots: Snapshot[],
  recordedEvents: SnapshotTimelineEvent[],
  idPrefix: string,
): SnapshotTimelineEvent[] {
  const recordedSnapshotIds = new Set(
    recordedEvents
      .filter(event => event.type === 'snapshot')
      .map(event => event.snapshotId)
      .filter((id): id is string => Boolean(id))
  )
  return snapshots
    .filter(snapshot => !recordedSnapshotIds.has(snapshot.id))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .map(snapshot => ({
      id: `${idPrefix}${snapshot.id}`,
      type: 'snapshot',
      createdAt: snapshot.createdAt,
      snapshotId: snapshot.id,
      note: snapshot.note,
    }))
}

// A revert note is required when later snapshots exist after the target.
// Recorded events decide when the target is in them; otherwise fall back to
// git's newest-first listing, where any earlier item is a later snapshot.
export async function revertNoteRequired(
  history: SnapshotHistoryState,
  targetSnapshotName: string,
  listSnapshots: () => Promise<Snapshot[]>,
): Promise<boolean> {
  const targetEventIndex = history.events.findIndex(
    event => event.type === 'snapshot' && event.snapshotId === targetSnapshotName
  )
  if (targetEventIndex >= 0) {
    return history.events
      .slice(targetEventIndex + 1)
      .some(event => event.type === 'snapshot')
  }

  const snapshots = await listSnapshots()
  const targetIndex = snapshots.findIndex(snapshot => snapshot.name === targetSnapshotName)
  if (targetIndex < 0) return false

  // listSnapshots sorts newest first; any earlier array item is a later timeline snapshot.
  return targetIndex > 0
}

// Before a revert or recovery replaces the inventory, keep a copy of it unless
// it already matches HEAD (and so is recoverable from git).
export async function createSafetyRecoveryPointIfNeeded(project: Project, git: GitService, logger: Logger): Promise<RecoveryPoint | null> {
  if (!project.path) return null

  const current = serializeProjectForPersistence(project)
  let head = ''
  try {
    head = canonicalizeDocumentJson(await git.readHeadDocument(project.path))
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.warn('could not compare current project to HEAD before revert', { path: project.path, error: msg })
  }

  if (head && head === current) return null

  const id = `recovery-${uuidv7()}`
  const recoveryDir = join(project.path, '.statekeep', 'recovery')
  // Recovery payloads are internal sidecars, not user-openable documents.
  // Keep their JSON suffix so they cannot be mistaken for Statekeep projects.
  const payloadPath = join('.statekeep', 'recovery', `${id}.document.json`)
  mkdirSync(recoveryDir, { recursive: true })
  writeFileSync(join(project.path, payloadPath), current, 'utf8')

  return {
    id,
    createdAt: new Date().toISOString(),
    reason: 'pre-revert',
    payloadPath,
  }
}
