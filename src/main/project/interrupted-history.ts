// Evidence left by history operations (the HistoryOperationStore journal):
// prove that an interrupted operation actually completed, build the review
// candidate for one that did not, and scan retained evidence the user may
// delete. Nothing here guesses: missing, altered, or unreadable evidence is
// left pending for the explicit review flow.

import { existsSync } from 'fs'
import { join } from 'path'
import type { InterruptedHistoryEvidencePreview, Project, Result } from '../../shared/types'
import { migrateSnapshotHistory, type SnapshotHistoryState } from '../../shared/snapshot-history-migration'
import type { HistoryOperationStore, RetainedHistoryOperationCandidate } from '../history-operation'
import type { GitService } from '../git-service'
import type { Logger } from '../logger'
import { PROJECT_DOCUMENT_FILE } from '../project-document-file'
import { canonicalizeDocumentJson, hashDocument, readDocumentBytes, serializeProjectForPersistence } from './document'
import { HistoryMetadataReadError, snapshotHistoryPath } from './history-metadata'

// What the journal helpers need from the open project. `readHistory` parses
// the given bytes, or reads history.json when called without them.
export interface JournalContext {
  project: Project
  store: HistoryOperationStore
  historyBytesOrNull: () => Buffer | null
  readHistory: (bytes?: Buffer) => SnapshotHistoryState
  parse: (raw: string) => Result<Project>
}

export function readHistoryBytesOrNull(store: HistoryOperationStore, projectPath: string): Buffer | null {
  try { return store.read(snapshotHistoryPath(projectPath)) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

// Clear the pending marker only when the document, history, and the
// operation's target (git snapshot, recovery payload, or backup) all match
// what the journal says a completed operation leaves behind.
export async function finishIfProvenComplete(
  ctx: JournalContext & { git: GitService; logger: Logger },
): Promise<void> {
  const { store, git, logger } = ctx
  const projectPath = ctx.project.path!
  try {
    const evidence = store.candidate()
    const { record } = evidence
    if (record.version === 3) {
      const document = readDocumentBytes(join(projectPath, PROJECT_DOCUMENT_FILE))
      const historyBytes = ctx.historyBytesOrNull()
      if (!document || !historyBytes || hashDocument(document) !== record.expectedDocumentHash ||
          hashDocument(historyBytes) !== record.expectedHistoryHash) return
      if (record.kind === 'recovery-register') {
        const history = migrateSnapshotHistory(JSON.parse(historyBytes.toString('utf8')))
        const point = history.recoveryPoints.find(point => point.id === record.targetId)
        if (!point) return
        const payload = store.read(join(projectPath, ...point.payloadPath.split(/[\\/]/)))
        if (hashDocument(payload) !== record.targetPayloadHash) return
      }
      if (record.kind === 'recovery-forget') {
        const history = migrateSnapshotHistory(JSON.parse(historyBytes.toString('utf8')))
        if (history.recoveryPoints.some(point => point.id === record.targetId)) return
      }
      if (record.kind === 'history-backup-restore') {
        const source = store.read(join(projectPath, '.statekeep', 'history.backup.json'))
        if (!evidence.source?.equals(source)) return
        const preservedPath = `${snapshotHistoryPath(projectPath)}.damaged-${record.id}`
        if (!record.historyMissing) {
          const preserved = store.read(preservedPath)
          if (!preserved.equals(evidence.history)) return
        } else if (existsSync(preservedPath)) return
      }
      const latestDocument = readDocumentBytes(join(projectPath, PROJECT_DOCUMENT_FILE))
      const latestHistory = ctx.historyBytesOrNull()
      if (!latestDocument?.equals(document) || !latestHistory?.equals(historyBytes)) return
      store.finish(true)
      logger.info('confirmed completed interrupted metadata operation', { path: projectPath, kind: record.kind })
      return
    }
    if (record.version !== 2) return
    const document = readDocumentBytes(join(projectPath, PROJECT_DOCUMENT_FILE))
    if (!document || hashDocument(document) !== record.expectedDocumentHash) return
    const history = ctx.readHistory()
    const event = history.events.at(-1)
    if (!event || event.id !== record.eventId) return

    let complete = false
    if (record.kind === 'snapshot-create' && event.type === 'snapshot' && event.snapshotId === record.targetId &&
        history.currentBaseSnapshotId === record.targetId && history.pendingRevertEventId === null &&
        history.snapshots[record.targetId]?.id === record.targetId) {
      const snapshotDocument = await git.readSnapshotDocument(projectPath, record.targetId)
      complete = hashDocument(snapshotDocument) === record.expectedDocumentHash
    } else if (record.kind === 'snapshot-revert' && event.type === 'revert' && event.targetSnapshotId === record.targetId &&
        history.currentBaseSnapshotId === record.targetId && history.pendingRevertEventId === record.eventId) {
      const snapshotDocument = await git.readSnapshotDocument(projectPath, record.targetId)
      // Revert rewrites a historical blob using the current serializer, so
      // compare its canonical form. Snapshot creation records the raw bytes.
      complete = hashDocument(canonicalizeDocumentJson(snapshotDocument)) === record.expectedDocumentHash
    } else if (record.kind === 'recovery-apply' && event.type === 'recover' && event.recoveryPointId === record.targetId &&
        history.currentBaseSnapshotId === null && history.pendingRevertEventId === record.eventId) {
      const recoveryPoint = history.recoveryPoints.find(point => point.id === record.targetId)
      if (recoveryPoint) {
        const recoveryDocument = store.read(join(projectPath, ...recoveryPoint.payloadPath.split(/[\\/]/)))
        complete = hashDocument(canonicalizeDocumentJson(recoveryDocument.toString('utf8'))) === record.expectedDocumentHash
      }
    }

    if (!complete) return
    // Recheck mutable evidence immediately before clearing the marker. This
    // closes the external-writer window opened by the Git/payload read above.
    const latestDocument = readDocumentBytes(join(projectPath, PROJECT_DOCUMENT_FILE))
    if (!latestDocument || hashDocument(latestDocument) !== record.expectedDocumentHash) return
    if (JSON.stringify(ctx.readHistory()) !== JSON.stringify(history)) return
    store.finish(true)
    logger.info('confirmed completed interrupted history operation', {
      path: projectPath, kind: record.kind, eventId: record.eventId,
    })
  } catch (error) {
    // Missing, altered, legacy, or unreadable evidence remains pending for
    // the explicit review flow. Automatic cleanup must never guess.
    logger.warn('could not prove interrupted history operation completed', { error: String(error) })
  }
}

// The pending operation as the review dialog sees it, plus a token over
// every input so acknowledging refuses if anything changed after review.
export function interruptedHistoryCandidate(ctx: JournalContext) {
  const { store, project } = ctx
  const evidence = store.candidate()
  const before = ctx.parse(evidence.inventory.toString('utf8'))
  if (!before.ok || before.data.id !== project.id) throw new Error('The preserved inventory is invalid or belongs to another project.')
  const metadataOnly = evidence.record.version === 3
  if (!metadataOnly) migrateSnapshotHistory(JSON.parse(evidence.history.toString('utf8')))
  const currentHistoryBytes = ctx.historyBytesOrNull()
  let history: SnapshotHistoryState | null = null
  let historyReadable = false
  if (currentHistoryBytes !== null) {
    try {
      history = ctx.readHistory(currentHistoryBytes)
      historyReadable = true
    } catch (error) {
      if (!(error instanceof HistoryMetadataReadError)) throw error
    }
  }
  const current = serializeProjectForPersistence(project)
  const disk = readDocumentBytes(join(project.path!, PROJECT_DOCUMENT_FILE))
  if (!disk) throw new Error('Restore or resolve the missing project document before continuing.')
  const token = metadataOnly || history === null ?
    store.fingerprint(evidence.bytes, evidence.inventory, evidence.history, evidence.source ?? '',
      currentHistoryBytes ?? 'missing-history', current, disk) :
    store.fingerprint(evidence.bytes, evidence.inventory, evidence.history, JSON.stringify(history), current, disk)
  return { store, evidence, before: before.data, history, currentHistoryBytes, metadataOnly, historyReadable, current, token }
}

// Retained evidence from operations that were already reviewed, grouped for
// the cleanup dialog. Unparseable groups are counted, never deleted.
export function scanInterruptedHistoryEvidence(ctx: JournalContext): {
  preview: InterruptedHistoryEvidencePreview
  candidates: Map<string, RetainedHistoryOperationCandidate>
} {
  const { store, project } = ctx
  if (!existsSync(store.recoveryPath)) {
    return { preview: { groups: [], unavailableCount: 0, uninspectedCount: 0, historyReadable: true }, candidates: new Map() }
  }
  const historyBytes = ctx.historyBytesOrNull()
  let history: SnapshotHistoryState | null = null
  if (historyBytes !== null) {
    try { history = ctx.readHistory(historyBytes) }
    catch (error) { if (!(error instanceof HistoryMetadataReadError)) throw error }
  }
  const retained = store.retainedCandidates()
  const candidates = new Map<string, RetainedHistoryOperationCandidate>()
  const groups: InterruptedHistoryEvidencePreview['groups'] = []
  let unavailableCount = retained.unavailableCount
  for (const candidate of retained.candidates) {
    try {
      const before = ctx.parse(candidate.inventory.toString('utf8'))
      if (!before.ok || before.data.id !== project.id) throw new Error('Invalid before-state inventory.')
      if (candidate.record.version !== 3 || candidate.record.kind !== 'history-backup-restore') {
        migrateSnapshotHistory(JSON.parse(candidate.history.toString('utf8')))
      }
      const registeredAsRecoveryPoint = history?.recoveryPoints.some(point =>
        point.payloadPath.split(/[\\/]/).pop() === candidate.record.inventoryFile)
      const record = candidate.record
      const token = store.fingerprint(candidate.bytes, candidate.inventory, candidate.history, candidate.source ?? '', historyBytes ?? 'missing-history',
        JSON.stringify([record.id, candidate.recordFile, registeredAsRecoveryPoint]))
      groups.push({
        id: record.id,
        token,
        label: record.label,
        startedAt: record.startedAt,
        kind: record.version === 1 ? null : record.kind,
        targetId: record.version === 1 ? null : record.targetId,
        beforeNodeCount: before.data.nodes.length,
        currentNodeCount: project.nodes.length,
        sizeBytes: candidate.bytes.length + candidate.inventory.length + candidate.history.length + (candidate.source?.length ?? 0),
        files: [candidate.recordFile, record.inventoryFile, record.historyFile,
          record.version === 3 ? record.sourceFile : undefined].filter((file): file is string => !!file),
        registeredAsRecoveryPoint: registeredAsRecoveryPoint ?? false,
      })
      candidates.set(record.id, candidate)
    } catch { unavailableCount++ }
  }
  groups.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  return { preview: { groups, unavailableCount, uninspectedCount: retained.uninspectedCount,
    historyReadable: history !== null }, candidates }
}
