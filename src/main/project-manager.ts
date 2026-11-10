// Project lifecycle: create, open, save, edit, and history operations.
// All filesystem operations go through here (or the ./project modules it
// calls). Never call fs directly from main/index.ts.
//
// State model:
//   - currentProject holds the in-memory project after open/create.
//   - All node mutations update currentProject then schedule an autosave.
//   - Autosave is debounced (AUTOSAVE_DEBOUNCE_MS). On close/quit,
//     call flushAndClose() to write immediately before clearing state.
//
// ┌─────────────────────────────────────────────┐
// │  IPC call (node:create / update / delete…)  │
// └────────────────────┬────────────────────────┘
//                      │
//                      ▼
//        planner in ./project (pure: validate, build next project)
//                      │
//                      ▼
//        commitProjectMutation (guards, search sync, edit history)
//                      │
//                      ├──▶ scheduleAutosave() ──▶ debounce ──▶ writeDocument()
//                      │
//                      └──▶ return Result<Project>
//
// Module boundaries: this class owns every piece of mutable state (the open
// project, operation flags, document versions, the history journal) and the
// ORDER of side effects — journal, search index, document write, history
// metadata. The ./project modules own computation: they take the current
// project (or injected readers) and return plans, previews, or errors, so
// they can be read and tested without the state machine around them.
//   ./project/document            parse/validate/serialize the project file, load warnings
//   ./project/nodes, templates    node and template CRUD planners
//   ./project/references          reference-field integrity
//   ./project/imports             CSV and NetBox import
//   ./project/inventory           inventory table and CSV export shaping
//   ./project/compare             snapshot compare and diff reports
//   ./project/history-metadata    history.json read/write and timeline helpers
//   ./project/node-history        per-node history walk
//   ./project/recovery            recovery-file and history-backup review
//   ./project/interrupted-history journal evidence: proof, review, cleanup scan
//   ./project/history-backfill    background history.db backfill (owns its own status)

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, lstatSync, realpathSync, unlinkSync, writeFileSync } from 'fs'
import { join, resolve, relative, isAbsolute, dirname, basename, sep } from 'path'
import { v7 as uuidv7 } from 'uuid'
import { EditHistory } from './edit-history'
import { HistoryBackupStore, writeHistoryFile } from './history-backup'
import { ProjectArchive } from './project-archive'
import { HistoryOperationStore, RetainedEvidenceChangedError, type HistoryOperationIntent,
  type MetadataHistoryOperationIntent, type PendingHistoryOperationV3 } from './history-operation'
import type { ProjectArchivePreview, ExternalDocumentPreview, InterruptedHistoryPreview,
  InterruptedHistoryEvidencePreview, InterruptedHistoryEvidenceDeleteResult } from '../shared/types'
import type { HistoryBackupStatus, HistoryBackupRestoreResult, RecoveryFilePreview } from '../shared/types'
import type { BatchPropertyUpdateRequest, BatchPropertyUpdateResult } from '../shared/batch-properties'
import {
  filterInventoryNodes,
  hasInventoryFilters,
  hasPropertyPredicate,
  inventoryFilterSnippet,
  validateInventoryFilters,
} from '../shared/inventory-filters'
import type { InventoryTablePage } from '../shared/inventory-table'
import type {
  Project,
  RecoveryPointApplyRequest,
  RecoveryPointApplyResult,
  ProjectNode,
  NodeHistory,
  NodeHistoryIndexStatus,
  SearchResult,
  SearchResultPage,
  Result,
  Snapshot,
  DiffEntry,
  SnapshotRevertRequest,
  SnapshotRevertResult,
  SnapshotTimelineEvent,
  SnapshotTimeline,
  RecoveryPoint,
  NodeTemplate,
  ImportMapping,
  ImportInspect,
  ImportPlan,
  ImportResult,
  NetboxInspect,
  NetboxImportOptions,
  NetboxImportPlan,
  NetboxImportResult,
} from '../shared/types'
import { ok, err, ErrorCode } from '../shared/errors'
import { migrate, getCurrentVersion } from '../shared/migration'
import {
  emptySnapshotHistory,
  migrateSnapshotHistory,
  type SnapshotHistoryState,
} from '../shared/snapshot-history-migration'
import { validateProjectDirectoryName, validateSnapshotName, validateSnapshotDescription } from '../shared/validation'
import { isCurrentRef } from '../shared/snapshot-ref'
import { buildMergedTree, type MergedTree } from '../shared/merged-tree'
import { isReportFormat } from '../shared/report'
import { SnapshotDocumentChangedError, type GitService } from './git-service'
import type { Logger } from './logger'
import { normalizeSearchPage, SearchIndexService } from './search-index'
import { HistoryIndexService } from './history-index'
import { findProjectDocument, PROJECT_DOCUMENT_FILE } from './project-document-file'
import {
  MAX_FILE_SIZE_BYTES,
  collectLoadWarnings,
  collectProjectWarnings,
  hashDocument,
  parseProjectDocument,
  readDocumentBytes,
  readDocumentHash,
  serializeProjectForPersistence,
  validateProjectDocument,
  withLoadWarnings,
  withProjectWarnings,
} from './project/document'
import type { ProjectMutation, SearchUpdate } from './project/mutation'
import {
  planNodeBatchPropertyUpdate,
  planNodeCreate,
  planNodeDelete,
  planNodeDuplicate,
  planNodeMove,
  planNodeUpdate,
  type NodeUpdateChanges,
} from './project/nodes'
import { planTemplateCreate, planTemplateDelete, planTemplateUpdate } from './project/templates'
import {
  inspectCsvImport,
  inspectNetboxImport,
  planCsvImport,
  planNetboxImport,
  previewCsvImport,
  previewNetboxImport,
} from './project/imports'
import {
  buildSortedInventory,
  inventoryCsvContent,
  inventoryCsvSuggestedName,
  inventoryPage,
  normalizeInventoryTableRequest,
  type PreparedInventoryTable,
} from './project/inventory'
import { formatComparisonReport, loadAndDiff, type LoadedComparison } from './project/compare'
import {
  HistoryMetadataReadError,
  createSafetyRecoveryPointIfNeeded,
  pruneRecoveryPoints,
  readSnapshotHistoryFile,
  revertNoteRequired,
  snapshotHistoryPath,
  synthesizeSnapshotEvents,
  withSnapshotMetadata,
  writeSnapshotHistoryFile,
} from './project/history-metadata'
import { walkNodeHistory } from './project/node-history'
import {
  HistoryBackupProjectChangedError,
  scanRecoveryFiles,
  validateHistoryBackup,
  type ValidatedHistoryBackup,
} from './project/recovery'
import {
  finishIfProvenComplete,
  interruptedHistoryCandidate,
  readHistoryBytesOrNull,
  scanInterruptedHistoryEvidence,
  type JournalContext,
} from './project/interrupted-history'
import { HistoryBackfill, type HistoryBackfillStatus } from './project/history-backfill'

export type { HistoryBackfillStatus } from './project/history-backfill'

const AUTOSAVE_DEBOUNCE_MS = 2500              // 2.5 seconds

class ExternalDocumentChangedError extends Error {}

export class ProjectManager {
  private historyBeforeOperation: SnapshotHistoryState | null = null
  private currentProject: Project | null = null
  private readonly edits = new EditHistory()
  private historyOperationInProgress = false
  private classifyingInterruptedHistory = false
  private archiveBusy = false
  private documentVersions = new Map<string, string | null>()
  private documentSaveError: { path: string; message: string } | null = null
  private conflictLocalCopy: { path: string; hash: string; file: string } | null = null
  private archivePreview: { path: string; token: string } | null = null
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null
  private readonly backfill: HistoryBackfill

  constructor(
    private readonly git: GitService,
    private readonly logger: Logger,
    private readonly search = new SearchIndexService(),
    private readonly history = new HistoryIndexService()
  ) {
    this.backfill = new HistoryBackfill({
      git,
      history,
      logger,
      currentProjectPath: () => this.currentProject?.path,
      isBlocked: () => this.hasInterruptedHistory(),
      readHistory: () => this.readSnapshotHistory(),
      parse: raw => this.parseDocumentJson(raw),
    })
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  getCurrent(): Project | null {
    return this.currentProject
  }

  // Create a new project at parentPath/name.
  // Auto-creates the root node and initialises git.
  async createProject(name: string, parentPath: string): Promise<Result<Project>> {
    if (this.historyOperationInProgress) return err(ErrorCode.VALIDATION_FAILED, 'Wait for the history operation to finish before switching projects.')
    if (this.archiveBusy) return err(ErrorCode.VALIDATION_FAILED, 'Wait for the archive operation to finish.')
    const nameCheck = validateProjectDirectoryName(name)
    if (!nameCheck.valid) return err(ErrorCode.VALIDATION_FAILED, nameCheck.message ?? 'Invalid project name.')
    const projectPath = join(parentPath, name)
    if (findProjectDocument(projectPath)) return err(ErrorCode.PROJECT_EXISTS, 'A project already exists in this folder.')
    try {
      mkdirSync(projectPath, { recursive: true })

      const now = new Date().toISOString()
      const rootId = uuidv7()
      const project: Project = {
        version: getCurrentVersion(),
        id: uuidv7(),
        name,
        created: now,
        modified: now,
        nodes: [
          {
            id: rootId,
            parentId: null,
            name,
            order: 0,
            properties: {},
            created: now,
            modified: now,
          },
        ],
        path: projectPath,
      }

      const saved = await this.writeDocument(project, { expectedDocumentHash: null })
      if (!saved.ok) return saved as Result<Project>
      await this.git.initRepo(projectPath)
      await this.git.initialCommit(projectPath)
      const searchResult = this.rebuildSearchIndex(project, 'initialize')
      if (!searchResult.ok) return searchResult as Result<Project>
      this.openHistoryIndex(projectPath)

      const projectWarnings = collectProjectWarnings(projectPath)
      const runtimeProject = withProjectWarnings(project, projectWarnings)
      this.edits.clear()
      this.currentProject = runtimeProject
      this.logger.info('project created', { name, path: projectPath })
      this.retainCurrentDocumentVersion()
      return ok(runtimeProject)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('project create failed', { name, path: projectPath, error: msg })
      return err(ErrorCode.PROJECT_NOT_FOUND, `Failed to create project: ${msg}`)
    }
  }

  // Open an existing project from a directory path.
  // Reads the project document, validates, migrates its schema, and rebuilds
  // the search index.
  async openProject(projectPath: string): Promise<Result<Project>> {
    if (this.historyOperationInProgress) return err(ErrorCode.VALIDATION_FAILED, 'Wait for the history operation to finish before switching projects.')
    if (this.archiveBusy) return err(ErrorCode.VALIDATION_FAILED, 'Wait for the archive operation to finish.')
    const documentPath = findProjectDocument(projectPath)
    if (!documentPath) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No Statekeep project document was found')
    }
    try {
      const stat = statSync(documentPath)
      if (stat.size > MAX_FILE_SIZE_BYTES) {
        const mb = Math.round(stat.size / 1024 / 1024)
        return err(ErrorCode.FILE_TOO_LARGE, `Project file is ${mb}MB (limit: 50MB)`)
      }

      const rawBytes = readFileSync(documentPath)
      const raw = rawBytes.toString('utf8')

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let data: any
      try {
        data = JSON.parse(raw)
      } catch {
        return err(ErrorCode.VALIDATION_FAILED, 'Project file is not valid JSON')
      }

      const originalVersion = data.version
      try {
        data = migrate(data)
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        return err(ErrorCode.SCHEMA_VERSION, msg)
      }

      const validation = validateProjectDocument(data, this.logger)
      if (!validation.ok) return validation as Result<Project>

      // Non-fatal, path-qualified integrity/type warnings. We never silently
      // coerce or downgrade hand-edited values on load — we surface them.
      // Warnings are a one-time, load-event payload: they ride the open
      // response but are NOT stored on currentProject, so they don't propagate
      // through subsequent mutation results.
      const warnings = collectLoadWarnings(data)
      const projectWarnings = collectProjectWarnings(projectPath)
      const project: Project = { ...data, path: projectPath }
      const openingHash = hashDocument(rawBytes)
      if (warnings.length > 0) {
        this.logger.warn('project loaded with warnings', { path: projectPath, count: warnings.length })
      }
      if (projectWarnings.length > 0) {
        this.logger.warn('project opened from cloud-synced folder', {
          path: projectPath,
          provider: projectWarnings[0].provider,
        })
      }

      // Persist a schema migration on first successful open.
      if (data.version !== originalVersion && !new HistoryOperationStore(projectPath, project.id).pending()) {
        const persisted = await this.writeDocument(project, { touchModified: false, expectedDocumentHash: openingHash })
        if (!persisted.ok) return persisted as Result<Project>
        this.logger.info('project document migrated', {
          path: projectPath,
          schemaFrom: originalVersion,
          schemaTo: data.version,
        })
      }

      const searchResult = this.rebuildSearchIndex(project, 'rebuild')
      if (!searchResult.ok) {
        return searchResult as Result<Project>
      }
      this.openHistoryIndex(projectPath)

      // Switching from an already-open project: stop the OUTGOING project's
      // background work before it becomes the incoming project's problem. Without
      // this, a pending autosave debounce would fire and write the NEW project,
      // and the in-flight backfill's `inProgress` guard would suppress the new
      // project's own backfill (backfill.schedule below early-returns while
      // a prior backfill is still running).
      if (this.currentProject) {
        this.cancelAutosave()
        this.backfill.cancel() // supersede any in-flight backfill so it bails
      }

      const runtimeProject = withProjectWarnings(project, projectWarnings)
      this.edits.clear()
      this.currentProject = runtimeProject
      this.documentSaveError = null
      this.logger.info('project opened', { name: project.name, path: projectPath, nodes: project.nodes.length })
      if (data.version === originalVersion || new HistoryOperationStore(projectPath, project.id).pending()) this.documentVersions.set(documentPath, openingHash)
      this.retainCurrentDocumentVersion()
      await this.finishProvenHistoryOperation()
      this.backfill.schedule()
      return ok(withLoadWarnings(runtimeProject, warnings))
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('project open failed', { path: projectPath, error: msg })
      return err(ErrorCode.PROJECT_NOT_FOUND, `Could not open project: ${msg}`)
    }
  }

  // Explicit save: called by autosave debounce and snapshot flush.
  // Uses atomic write (tmp → rename).
  async saveProject(): Promise<Result<void>> {
    if (this.hasInterruptedHistory()) return this.interruptedHistoryError()
    if (!this.currentProject) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    }
    return this.writeDocument(this.currentProject)
  }

  // Flush autosave immediately and clear in-memory state only after the final
  // save succeeds. Callers that intentionally discard after a failed save must
  // use discardCurrentProject() so final-save failures are never silent.
  async flushAndClose(): Promise<Result<void>> {
    if (this.historyOperationInProgress) return err(ErrorCode.VALIDATION_FAILED, 'Wait for the history operation to finish before closing the project.')
    if (this.archiveBusy) return err(ErrorCode.VALIDATION_FAILED, 'Wait for the archive operation to finish.')
    this.cancelAutosave()
    const result = await this.saveProject()
    if (!result.ok) return result
    this.discardCurrentProject()
    return result
  }

  discardCurrentProject(): void {
    this.cancelAutosave()
    this.edits.clear()
    this.currentProject = null
    this.documentSaveError = null
    this.documentVersions.clear()
    this.conflictLocalCopy = null
    this.search.close()
    this.history.close()
    this.backfill.cancel()  // signal any in-flight backfill to exit early
  }

  getHistoryBackfillStatus(): HistoryBackfillStatus {
    return this.backfill.getStatus()
  }

  getHistoryIndexStatus(): NodeHistoryIndexStatus {
    let incompleteSnapshotIds: string[] = []
    if (this.currentProject?.path) {
      try {
        incompleteSnapshotIds = this.history.getIncompleteSnapshots().map(snapshot => snapshot.snapshotId)
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        if (/history index is not open/i.test(msg)) {
          return {
            ...this.backfill.getStatus(),
            incompleteCount: 0,
            incompleteSnapshotIds: [],
          }
        }
        this.logger.warn('history index status failed', { error: msg })
      }
    }

    return {
      ...this.backfill.getStatus(),
      incompleteCount: incompleteSnapshotIds.length,
      incompleteSnapshotIds,
    }
  }

  reindexHistory(): Result<NodeHistoryIndexStatus> {
    if (!this.currentProject?.path) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    }
    this.backfill.schedule()
    return ok(this.getHistoryIndexStatus())
  }

  // Awaitable handle for the most recently scheduled backfill. Tests use this
  // to deterministically wait for backfill to finish without polling. UI does
  // not need this — it polls getHistoryBackfillStatus for the progress display.
  async waitForHistoryBackfill(): Promise<void> {
    await this.backfill.wait()
  }

  editHistoryState() { return this.edits.state() }

  undo(): Result<Project> { return this.applyEditHistory('undo') }
  redo(): Result<Project> { return this.applyEditHistory('redo') }

  private applyEditHistory(direction: 'undo' | 'redo'): Result<Project> {
    if (this.hasInterruptedHistory()) return this.interruptedHistoryError()
    const previous = this.currentProject
    if (!previous) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project open')
    if (this.documentSaveError && this.documentSaveError.path === previous.path) return err(ErrorCode.EXTERNAL_DOCUMENT_CHANGED, this.documentSaveError.message)
    if (this.historyOperationInProgress) {
      return err(ErrorCode.VALIDATION_FAILED, 'Wait for the snapshot or recovery operation to finish.')
    }
    const next = this.edits.preview(previous, direction)
    if (!next) return err(ErrorCode.VALIDATION_FAILED, `Nothing to ${direction}.`)
    const indexed = this.rebuildSearchIndex(next, 'rebuild')
    if (!indexed.ok) {
      this.restoreSearchIndex(previous)
      return indexed as Result<Project>
    }
    this.currentProject = next
    this.edits.accept(direction)
    this.scheduleAutosave()
    return ok(next)
  }

  private async withHistoryOperation<T>(operation: () => Promise<Result<T>>): Promise<Result<T>> {
    if (this.hasInterruptedHistory()) return this.interruptedHistoryError()
    if (this.historyOperationInProgress) {
      return err(ErrorCode.VALIDATION_FAILED, 'Wait for the snapshot or recovery operation to finish.')
    }
    this.historyOperationInProgress = true
    try {
      // Check before autosave cancellation, git changes, or recovery payload writes.
      if (this.currentProject?.path) this.assertDocumentUnchanged(this.currentProject.path)
      const history = this.readSnapshotHistory()
      this.historyBeforeOperation = history
      if (this.currentProject?.path && existsSync(snapshotHistoryPath(this.currentProject.path))) {
        try {
          mkdirSync(join(this.currentProject.path, '.statekeep'), { recursive: true })
          new HistoryBackupStore(this.currentProject.path, this.currentProject.id).save(history)
        } catch (error) {
          return err(ErrorCode.HISTORY_BACKUP_FAILED, `Could not protect history before the operation: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const result = await operation()
      if (result.ok && this.hasInterruptedHistory()) {
        try { this.operationStore()!.finish() }
        catch (error) {
          this.logger.warn('history operation committed; retrying evidence cleanup', { error: String(error) })
          await this.finishProvenHistoryOperation()
        }
      }
      return result
    } catch (e: unknown) {
      if (e instanceof ExternalDocumentChangedError) return err(ErrorCode.EXTERNAL_DOCUMENT_CHANGED, e.message)
      if (e instanceof HistoryMetadataReadError) {
        return err(ErrorCode.HISTORY_METADATA_UNAVAILABLE, e.message)
      }
      const message = e instanceof Error ? e.message : String(e)
      return this.hasInterruptedHistory()
        ? err(ErrorCode.HISTORY_OPERATION_PENDING, `History operation could not finish: ${message}. Review the pending operation before continuing.`)
        : err(ErrorCode.HISTORY_OPERATION_FAILED, `History operation stopped before any journaled change: ${message}`)
    }
    finally {
      this.historyOperationInProgress = false
      this.historyBeforeOperation = null
    }
  }

  // ─── Node CRUD ──────────────────────────────────────────────────────────────
  // Validation and next-state construction live in ./project/nodes; these
  // methods add the guards that depend on manager state and commit.

  nodeCreate(parentId: string, name: string, templateId?: string | null): Result<Project> {
    if (!this.currentProject) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project open')
    return this.commitPlannedMutation(planNodeCreate(this.currentProject, parentId, name, templateId))
  }

  nodeDuplicate(id: string, name: string): Result<Project> {
    const project = this.currentProject
    if (!project) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project open')
    if (this.historyOperationInProgress) {
      return err(ErrorCode.VALIDATION_FAILED, 'Wait for the snapshot or recovery operation to finish.')
    }
    return this.commitPlannedMutation(planNodeDuplicate(project, id, name))
  }

  nodeBatchUpdateProperties(request: BatchPropertyUpdateRequest): Result<BatchPropertyUpdateResult> {
    const project = this.currentProject
    if (!project) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project open')
    if (this.historyOperationInProgress) {
      return err(ErrorCode.VALIDATION_FAILED, 'Wait for the snapshot or recovery operation to finish.')
    }
    const planned = planNodeBatchPropertyUpdate(project, request)
    if (!planned.ok) return planned
    const { mutation, changesApplied } = planned.data
    if (!mutation) return ok({ project, changesApplied })
    const committed = this.commitMutation(mutation)
    return committed.ok
      ? ok({ project: committed.data, changesApplied })
      : committed
  }

  nodeUpdate(id: string, changes: NodeUpdateChanges): Result<Project> {
    if (!this.currentProject) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project open')
    return this.commitPlannedMutation(planNodeUpdate(this.currentProject, id, changes))
  }

  nodeDelete(id: string, options?: { unlinkReferences?: boolean }): Result<Project> {
    if (!this.currentProject) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project open')
    return this.commitPlannedMutation(planNodeDelete(this.currentProject, id, options))
  }

  nodeMove(id: string, newParentId: string, newOrder: number): Result<Project> {
    const project = this.currentProject
    if (!project) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project open')
    const planned = planNodeMove(project, id, newParentId, newOrder)
    if (!planned.ok) return planned
    // Already in position: return the project as-is without recording an edit.
    if (!planned.data) return ok(project)
    return this.commitMutation(planned.data)
  }

  // ─── Template CRUD ────────────────────────────────────────────────────────────

  templateCreate(id: string, template: NodeTemplate): Result<Project> {
    if (!this.currentProject) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project open')
    return this.commitPlannedMutation(planTemplateCreate(this.currentProject, id, template))
  }

  templateUpdate(id: string, changes: Partial<NodeTemplate>): Result<Project> {
    if (!this.currentProject) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project open')
    return this.commitPlannedMutation(planTemplateUpdate(this.currentProject, id, changes))
  }

  templateDelete(id: string): Result<Project> {
    if (!this.currentProject) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project open')
    return this.commitPlannedMutation(planTemplateDelete(this.currentProject, id))
  }

  // ─── CSV and NetBox import ───────────────────────────────────────────────────

  inspectImport(path: string): Result<ImportInspect> {
    return inspectCsvImport(path)
  }

  planImportCsv(path: string, mapping: ImportMapping): Result<ImportPlan> {
    if (!this.currentProject) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project open')
    return previewCsvImport(this.currentProject, path, mapping)
  }

  applyImportCsv(path: string, mapping: ImportMapping): Result<{ project: Project; summary: ImportResult }> {
    const project = this.currentProject
    if (!project) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project open')
    const planned = planCsvImport(project, path, mapping)
    if (!planned.ok) return planned
    const { mutation, summary } = planned.data
    if (!mutation) return ok({ project, summary })
    const committed = this.commitMutation(mutation)
    if (!committed.ok) return committed as Result<{ project: Project; summary: ImportResult }>
    return ok({ project: committed.data, summary })
  }

  inspectNetboxImport(path: string): Result<NetboxInspect> {
    return inspectNetboxImport(path)
  }

  planNetboxImport(path: string, options: NetboxImportOptions): Result<NetboxImportPlan> {
    if (!this.currentProject) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project open')
    return previewNetboxImport(this.currentProject, path, options)
  }

  applyNetboxImport(
    path: string,
    options: NetboxImportOptions,
  ): Result<{ project: Project; summary: NetboxImportResult }> {
    const project = this.currentProject
    if (!project) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project open')
    const planned = planNetboxImport(project, path, options)
    if (!planned.ok) return planned
    const { mutation, summary } = planned.data
    if (!mutation) return ok({ project, summary })
    const committed = this.commitMutation(mutation)
    if (!committed.ok) return committed as Result<{ project: Project; summary: NetboxImportResult }>
    return ok({ project: committed.data, summary })
  }

  // ─── Search ─────────────────────────────────────────────────────────────────

  // Compatibility entry point for internal callers that only need the first page.
  searchNodes(query: string): Result<SearchResult[]> {
    const page = this.searchNodesPage(query)
    return page.ok ? ok(page.data.results) : page
  }

  searchNodesPage(
    query: string,
    offset = 0,
    limit = 50,
    rawFilters: unknown = {},
  ): Result<SearchResultPage> {
    const { offset: safeOffset, limit: safeLimit } = normalizeSearchPage(offset, limit)
    if (!this.currentProject) return ok({ results: [], total: 0, offset: safeOffset, hasMore: false })
    const filterCheck = validateInventoryFilters(rawFilters)
    if (!filterCheck.valid) return err(ErrorCode.VALIDATION_FAILED, filterCheck.message)
    const filters = filterCheck.filters

    const q = query.trim().toLowerCase()
    const filtersActive = hasInventoryFilters(filters)
    if (!q && !filtersActive) return ok({ results: [], total: 0, offset: safeOffset, hasMore: false })

    const nodeMap = new Map(this.currentProject.nodes.map(n => [n.id, n]))
    const project = this.currentProject
    const eligibleNodes = filtersActive ? filterInventoryNodes(project, filters) : project.nodes

    const mapNode = (
      node: ProjectNode,
      matchField: SearchResult['matchField'],
      snippet: string,
    ): SearchResult => {
      const parent = node.parentId ? nodeMap.get(node.parentId) : null
      return {
        nodeId: node.id,
        nodeName: node.name,
        parentName: parent?.name ?? null,
        matchField,
        snippet: snippet || node.name,
      }
    }

    if (!q) {
      const pageNodes = eligibleNodes.slice(safeOffset, safeOffset + safeLimit)
      const matchField = (hasPropertyPredicate(filters) || filters.missingRequired) ? 'property' : 'filter'
      return ok({
        results: pageNodes.map(node => mapNode(node, matchField, inventoryFilterSnippet(project, node, filters))),
        total: eligibleNodes.length,
        offset: safeOffset,
        hasMore: safeOffset + pageNodes.length < eligibleNodes.length,
      })
    }

    const queryCurrentIndex = (): SearchResultPage => {
      if (!this.search.hasExactNodeSet(project.path!, nodeMap.keys())) {
        throw new Error('Search index node set does not match the current project')
      }
      const page = this.search.queryPage(
        project.path!,
        q,
        safeOffset,
        safeLimit,
        filtersActive ? eligibleNodes.map(node => node.id) : undefined,
      )
      const results = page.hits.map(hit => {
        const node = nodeMap.get(hit.nodeId)
        if (!node) throw new Error(`Search index returned unknown node: ${hit.nodeId}`)
        return mapNode(node, hit.matchField, hit.snippet)
      })
      return { results, total: page.total, offset: page.offset, hasMore: page.hasMore }
    }

    try {
      return ok(queryCurrentIndex())
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.warn('search query failed; attempting index rebuild', {
        path: project.path,
        error: msg,
      })

      const rebuildResult = this.rebuildSearchIndex(project, 'rebuild')
      if (!rebuildResult.ok) {
        return err(
          ErrorCode.SQLITE_CAPABILITY,
          `Search is unavailable: ${rebuildResult.error.message}`
        )
      }

      try {
        return ok(queryCurrentIndex())
      } catch (retryError: unknown) {
        const retryMsg = retryError instanceof Error ? retryError.message : String(retryError)
        this.logger.error('search query failed after rebuild', { path: project.path, error: retryMsg })
        return err(ErrorCode.SQLITE_CAPABILITY, `Search is unavailable: ${retryMsg}`)
      }
    }
  }

  inventoryTable(rawRequest: unknown): Result<InventoryTablePage> {
    const prepared = this.prepareInventoryTable(rawRequest)
    if (!prepared.ok) return prepared
    return ok(inventoryPage(prepared.data))
  }

  prepareInventoryCsv(rawRequest: unknown): Result<{ suggestedName: string }> {
    const normalized = normalizeInventoryTableRequest(this.currentProject, rawRequest)
    if (!normalized.ok) return normalized
    return ok({ suggestedName: inventoryCsvSuggestedName(this.currentProject) })
  }

  buildInventoryCsv(rawRequest: unknown): Result<{ content: string; suggestedName: string; rowCount: number }> {
    const prepared = this.prepareInventoryTable(rawRequest)
    if (!prepared.ok) return prepared
    return ok({
      content: inventoryCsvContent(prepared.data),
      suggestedName: inventoryCsvSuggestedName(this.currentProject),
      rowCount: prepared.data.rows.length,
    })
  }

  // Select the request's nodes (filters, then the search index for a query,
  // rebuilding it once if it is stale) and build sorted rows.
  private prepareInventoryTable(rawRequest: unknown): Result<PreparedInventoryTable> {
    const normalized = normalizeInventoryTableRequest(this.currentProject, rawRequest)
    if (!normalized.ok) return normalized
    const request = normalized.data
    const project = this.currentProject!
    const filtersActive = hasInventoryFilters(request.filters)

    let nodes: ProjectNode[]
    if (!request.query) {
      nodes = filtersActive
        ? filterInventoryNodes(project, request.filters)
        : [...project.nodes]
    } else {
      const nodeMap = new Map(project.nodes.map(node => [node.id, node]))
      const eligibleNodes = filtersActive
        ? filterInventoryNodes(project, request.filters)
        : project.nodes
      const queryAll = (): ProjectNode[] => {
        if (!this.search.hasExactNodeSet(project.path!, nodeMap.keys())) {
          throw new Error('Search index node set does not match the current project')
        }
        return this.search.queryAll(
          project.path!,
          request.query,
          filtersActive ? eligibleNodes.map(node => node.id) : undefined,
        ).flatMap(hit => {
          const node = nodeMap.get(hit.nodeId)
          return node ? [node] : []
        })
      }
      try {
        nodes = queryAll()
      } catch {
        const rebuilt = this.rebuildSearchIndex(project, 'rebuild')
        if (!rebuilt.ok) return rebuilt
        try {
          nodes = queryAll()
        } catch (retryError) {
          const message = retryError instanceof Error ? retryError.message : String(retryError)
          return err(ErrorCode.SQLITE_CAPABILITY, `Inventory search is unavailable: ${message}`)
        }
      }
    }

    return ok(buildSortedInventory(project, nodes, request))
  }

  // ─── Archives ───────────────────────────────────────────────────────────────

  private archiveService(): ProjectArchive {
    return new ProjectArchive(this.git, raw => {
      const result = this.parseDocumentJson(raw)
      if (!result.ok) throw new Error(result.error.message)
      return result.data
    })
  }

  async exportProjectArchive(destination: string): Promise<Result<{ path: string }>> {
    if (this.hasInterruptedHistory()) return this.interruptedHistoryError()
    if (!this.currentProject?.path) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    if (this.archiveBusy || this.historyOperationInProgress) return err(ErrorCode.VALIDATION_FAILED, 'Wait for the current history or archive operation to finish.')
    try {
      const target = relative(realpathSync(this.currentProject.path), join(realpathSync(dirname(resolve(destination))), basename(destination)))
      if (target.split(sep)[0] !== '..' && !isAbsolute(target)) return err(ErrorCode.VALIDATION_FAILED, 'Save the archive outside the project folder.')
    } catch (error) { return err(ErrorCode.ARCHIVE_FAILED, `Archive destination is unavailable: ${String(error)}`) }
    this.archiveBusy = true
    this.historyOperationInProgress = true
    try {
      this.assertDocumentUnchanged(this.currentProject.path)
      this.readSnapshotHistory()
      await this.archiveService().export(this.currentProject.path, serializeProjectForPersistence(this.currentProject), destination)
      return ok({ path: destination })
    } catch (error) {
      return err(ErrorCode.ARCHIVE_FAILED, `Could not export project archive: ${error instanceof Error ? error.message : String(error)}`)
    } finally { this.archiveBusy = false; this.historyOperationInProgress = false }
  }

  async inspectProjectArchive(path: string): Promise<Result<ProjectArchivePreview>> {
    if (this.archiveBusy) return err(ErrorCode.VALIDATION_FAILED, 'Wait for the archive operation to finish.')
    this.archiveBusy = true
    this.archivePreview = null
    try {
      const preview = await this.archiveService().inspect(path)
      this.archivePreview = { path, token: preview.token }
      return ok(preview)
    } catch (error) {
      return err(ErrorCode.ARCHIVE_FAILED, `Could not verify project archive: ${error instanceof Error ? error.message : String(error)}`)
    } finally { this.archiveBusy = false }
  }

  async restoreProjectArchive(token: unknown, parent: string): Promise<Result<{ path: string }>> {
    if (this.archiveBusy || this.historyOperationInProgress) return err(ErrorCode.VALIDATION_FAILED, 'Wait for the current history or archive operation to finish.')
    const preview = this.archivePreview
    if (!preview || typeof token !== 'string' || preview.token !== token) return err(ErrorCode.VALIDATION_FAILED, 'Review the archive before restoring.')
    this.archiveBusy = true
    try {
      const path = await this.archiveService().restore(preview.path, token, parent)
      this.archivePreview = null
      return ok({ path })
    } catch (error) {
      this.archivePreview = null
      return err(ErrorCode.ARCHIVE_FAILED, `Could not restore project archive: ${error instanceof Error ? error.message : String(error)}`)
    } finally { this.archiveBusy = false }
  }

  // ─── Recovery files and history backup ───────────────────────────────────────

  private scanRecoveryFiles(): RecoveryFilePreview {
    return scanRecoveryFiles(this.currentProject!, () => this.readSnapshotHistory(), raw => this.parseDocumentJson(raw))
  }

  async recoveryFilesPreview(): Promise<Result<RecoveryFilePreview>> {
    if (!this.currentProject?.path) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    try { return ok(this.scanRecoveryFiles()) } catch (error) {
      return err(error instanceof HistoryMetadataReadError ? ErrorCode.HISTORY_METADATA_UNAVAILABLE : ErrorCode.SNAPSHOT_READ_FAILED,
        `Could not inspect recovery files: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async adoptRecoveryFile(request: unknown): Promise<Result<RecoveryPoint>> {
    if (!this.currentProject?.path) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    if (!request || typeof request !== 'object' || !('token' in request) || typeof request.token !== 'string' ||
        !('name' in request) || typeof request.name !== 'string') {
      return err(ErrorCode.VALIDATION_FAILED, 'Review recovery files before adding one.')
    }
    return this.withHistoryOperation(async () => {
      try {
        const preview = this.scanRecoveryFiles()
        if (preview.token !== request.token) return err(ErrorCode.VALIDATION_FAILED, 'Recovery files changed. Review them again.')
        const file = preview.files.find(file => file.name === request.name && file.eligible)
        if (!file) return err(ErrorCode.VALIDATION_FAILED, 'This file cannot be added as a recovery point.')
        // Keep the payload filename, but use a new identity so old timeline
        // references cannot silently attach invented provenance to this point.
        const point: RecoveryPoint = {
          id: `reconciled-${uuidv7()}`, createdAt: new Date().toISOString(),
          reason: 'reconciled', payloadPath: `.statekeep/recovery/${file.name}`,
        }
        if (this.scanRecoveryFiles().token !== request.token) {
          return err(ErrorCode.VALIDATION_FAILED, 'Recovery files changed. Review them again.')
        }
        const payload = this.operationStore()!.read(join(this.currentProject!.path!, '.statekeep', 'recovery', file.name))
        const parsedPayload = this.parseDocumentJson(payload.toString('utf8'))
        if (!parsedPayload.ok || parsedPayload.data.id !== this.currentProject!.id) {
          return err(ErrorCode.VALIDATION_FAILED, 'Recovery file changed. Review it again.')
        }
        const history = structuredClone(this.historyBeforeOperation!)
        history.recoveryPoints.push(point)
        // Registration is not an inventory event. Never invent a revert or
        // recover event, change lineage, or prune files during reconciliation.
        this.beginMetadataHistoryOperation(`Register recovery file: ${file.name}`, {
          kind: 'recovery-register', targetId: point.id,
          expectedHistoryHash: hashDocument(JSON.stringify(history, null, 2)),
          targetPayloadHash: hashDocument(payload),
        })
        this.writeSnapshotHistory(history)
        return ok(point)
      } catch (error) {
        return err(this.hasInterruptedHistory() ? ErrorCode.HISTORY_OPERATION_PENDING :
          error instanceof HistoryMetadataReadError ? ErrorCode.HISTORY_METADATA_UNAVAILABLE : ErrorCode.HISTORY_BACKUP_FAILED,
          `Could not add recovery file: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  async forgetRecoveryFile(request: unknown): Promise<Result<void>> {
    if (!this.currentProject?.path) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    if (!request || typeof request !== 'object' || !('id' in request) || typeof request.id !== 'string') {
      return err(ErrorCode.VALIDATION_FAILED, 'Choose an added recovery point to remove from the list.')
    }
    const recoveryId = request.id
    return this.withHistoryOperation(async () => {
      const history = structuredClone(this.historyBeforeOperation!)
      if (!history.recoveryPoints.some(point => point.id === recoveryId && point.reason === 'reconciled')) {
        return err(ErrorCode.VALIDATION_FAILED, 'Only explicitly added recovery points can be removed from this list.')
      }
      history.recoveryPoints = history.recoveryPoints.filter(point => point.id !== recoveryId)
      try {
        this.beginMetadataHistoryOperation(`Remove recovery registration: ${recoveryId}`, {
          kind: 'recovery-forget', targetId: recoveryId,
          expectedHistoryHash: hashDocument(JSON.stringify(history, null, 2)),
        })
        this.writeSnapshotHistory(history, { deleteRemovedPayloads: false })
        return ok(undefined)
      } catch (error) {
        return err(this.hasInterruptedHistory() ? ErrorCode.HISTORY_OPERATION_PENDING :
          error instanceof HistoryMetadataReadError ? ErrorCode.HISTORY_METADATA_UNAVAILABLE : ErrorCode.HISTORY_BACKUP_FAILED,
          `Could not remove recovery point: ${String(error)}`)
      }
    })
  }

  private async validatedHistoryBackup(): Promise<ValidatedHistoryBackup> {
    const project = this.currentProject
    return validateHistoryBackup(
      project,
      this.git,
      () => this.currentProject?.path === project?.path && this.currentProject?.id === project?.id,
      raw => this.parseDocumentJson(raw),
    )
  }

  async historyBackupStatus(): Promise<Result<HistoryBackupStatus>> {
    if (!this.currentProject?.path) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    try {
      const candidate = await this.validatedHistoryBackup()
      return ok({
        available: true, token: candidate.token, savedAt: candidate.savedAt,
        snapshotCount: Object.keys(candidate.history.snapshots).length,
        eventCount: candidate.history.events.length,
        recoveryPointCount: candidate.history.recoveryPoints.length,
        missingSnapshots: candidate.missingSnapshots, unlistedRecoveryFiles: candidate.unlistedRecoveryFiles,
        originalMissing: candidate.damaged === null,
      })
    } catch (error) {
      if (error instanceof HistoryBackupProjectChangedError) {
        return err(ErrorCode.VALIDATION_FAILED, error.message)
      }
      return ok({ available: false, reason: `No restorable automatic backup: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  async restoreHistoryBackup(request: unknown): Promise<Result<HistoryBackupRestoreResult>> {
    if (!this.currentProject?.path) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    if (this.hasInterruptedHistory()) return this.interruptedHistoryError()
    if (this.historyOperationInProgress) return err(ErrorCode.VALIDATION_FAILED, 'Wait for the snapshot or recovery operation to finish.')
    if (!request || typeof request !== 'object' || !('token' in request) || typeof request.token !== 'string') {
      return err(ErrorCode.VALIDATION_FAILED, 'Review the history backup before restoring it.')
    }
    this.historyOperationInProgress = true
    try {
      const candidate = await this.validatedHistoryBackup()
      if (candidate.token !== request.token) return err(ErrorCode.VALIDATION_FAILED, 'History files changed. Review the backup again before restoring.')
      const backupStore = new HistoryBackupStore(this.currentProject.path, this.currentProject.id)
      const restored = migrateSnapshotHistory({
        ...candidate.history, currentBaseSnapshotId: null, pendingRevertEventId: null,
      })
      const record = this.beginMetadataHistoryOperation('Restore history from automatic backup', {
        kind: 'history-backup-restore', targetId: 'history.backup.json',
        expectedHistoryHash: hashDocument(JSON.stringify(restored, null, 2)),
      }, candidate.source)
      const preservedPath = backupStore.restore(candidate, `${backupStore.historyPath}.damaged-${record.id}`)
      try { this.operationStore()!.finish() }
      catch (error) {
        this.logger.warn('history backup restored; retrying evidence cleanup', { error: String(error) })
        await this.finishProvenHistoryOperation()
      }
      this.backfill.schedule()
      return ok({ preservedPath })
    } catch (error) {
      return err(this.hasInterruptedHistory() ? ErrorCode.HISTORY_OPERATION_PENDING : ErrorCode.HISTORY_BACKUP_FAILED,
        `Could not restore history backup: ${error instanceof Error ? error.message : String(error)}`)
    } finally { this.historyOperationInProgress = false }
  }

  // ─── Snapshots ──────────────────────────────────────────────────────────────

  async snapshotCreate(name: unknown, description: unknown = null): Promise<Result<Snapshot>> {
    return this.withHistoryOperation(() => this.performSnapshotCreate(name, description))
  }

  private async performSnapshotCreate(name: unknown, description: unknown): Promise<Result<Snapshot>> {
    if (!this.currentProject) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    }

    if (typeof name !== 'string') {
      return err(ErrorCode.VALIDATION_FAILED, 'Snapshot name must be text')
    }

    const validation = validateSnapshotName(name)
    if (!validation.valid) {
      return err(ErrorCode.VALIDATION_FAILED, validation.message ?? 'Invalid snapshot name')
    }
    const descriptionValidation = validateSnapshotDescription(description)
    if (!descriptionValidation.valid) {
      return err(ErrorCode.VALIDATION_FAILED, descriptionValidation.message ?? 'Invalid snapshot description')
    }
    const note = typeof description === 'string' ? description.trim() || null : null

    if ((await this.git.listSnapshots(this.currentProject.path!)).some(snapshot => snapshot.name === name)) {
      return err(ErrorCode.VALIDATION_FAILED, `Snapshot "${name}" already exists`)
    }
    const flushResult = await this.flushPendingAutosave()
    if (!flushResult.ok) {
      return flushResult as Result<Snapshot>
    }

    const eventId = uuidv7()
    // A completed flush updates documentVersions. The fallback covers an
    // already-current document whose bytes did not need another write.
    const expectedDocumentHash = this.documentVersions.get(join(this.currentProject.path!, PROJECT_DOCUMENT_FILE)) ??
      hashDocument(serializeProjectForPersistence(this.currentProject))
    this.beginHistoryOperation(`Create snapshot: ${name}`, {
      kind: 'snapshot-create', eventId, targetId: name,
      expectedDocumentHash,
    })

    try {
      const snapshot = await this.git.createSnapshot(this.currentProject.path!, name,
        this.documentVersions.get(join(this.currentProject.path!, PROJECT_DOCUMENT_FILE)) ?? undefined)
      const history = structuredClone(this.historyBeforeOperation!)
      const event: SnapshotTimelineEvent = {
        id: eventId,
        type: 'snapshot',
        createdAt: snapshot.createdAt,
        snapshotId: snapshot.id,
        note,
      }
      const snapshotMeta = {
        id: snapshot.id,
        basedOnSnapshotId: history.currentBaseSnapshotId,
        createdAfterRevertEventId: history.pendingRevertEventId,
        note,
      }
      history.snapshots[snapshot.id] = snapshotMeta
      history.events.push(event)
      history.currentBaseSnapshotId = snapshot.id
      history.pendingRevertEventId = null
      this.writeSnapshotHistory(history)
      this.logger.info('snapshot created', { name, path: this.currentProject.path })

      // Per-node history index (best effort — failures recover via backfill).
      // Pass the just-updated history so we can derive chronological order
      // from event push order (authoritative, unlike git's second-precision
      // creatordate sort which is unstable for snapshots created the same
      // second).
      await this.recordSnapshotInHistory(snapshot.id, this.currentProject, history)

      return ok({
        ...snapshot,
        basedOnSnapshotId: snapshotMeta.basedOnSnapshotId,
        createdAfterRevertEventId: snapshotMeta.createdAfterRevertEventId,
        note: snapshotMeta.note,
      })
    } catch (e: unknown) {
      if (e instanceof SnapshotDocumentChangedError) {
        try { this.assertDocumentUnchanged(this.currentProject!.path!) } catch { /* Preserve the current inventory and expose conflict status. */ }
        this.abortHistoryOperation()
        return err(ErrorCode.EXTERNAL_DOCUMENT_CHANGED, e.message)
      }
      const msg = e instanceof Error ? e.message : String(e)
      const code = msg.includes('already exists') ? ErrorCode.VALIDATION_FAILED : ErrorCode.GIT_COMMIT_FAILED
      const message = code === ErrorCode.VALIDATION_FAILED
        ? `Snapshot "${name}" already exists`
        : `Failed to create snapshot: ${msg}`
      this.logger.error('snapshot create failed', { name, path: this.currentProject.path, error: msg })
      return err(code, message)
    }
  }

  async snapshotList(): Promise<Result<Snapshot[]>> {
    if (!this.currentProject?.path) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    }

    try {
      const snapshots = await this.git.listSnapshots(this.currentProject.path)
      return ok(withSnapshotMetadata(snapshots, this.readSnapshotHistory()))
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('snapshot list failed', { path: this.currentProject.path, error: msg })
      return err(e instanceof HistoryMetadataReadError ? ErrorCode.HISTORY_METADATA_UNAVAILABLE : ErrorCode.GIT_COMMIT_FAILED, `Failed to list snapshots: ${msg}`)
    }
  }

  async snapshotTimeline(): Promise<Result<SnapshotTimeline>> {
    if (!this.currentProject?.path) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    }

    try {
      const history = this.readSnapshotHistory()
      const listed = await this.git.listSnapshots(this.currentProject.path)
      // Re-read after the await, as before the split: metadata comes from the
      // history as it is now, events from the read above.
      const snapshots = withSnapshotMetadata(listed, this.readSnapshotHistory())
      // Recorded events keep their push order (the order they actually happened).
      // Sorting them by createdAt would shuffle revert/recover events relative to
      // snapshot events, because git tags carry second-resolution timestamps while
      // revert/recover events are recorded at millisecond resolution — so a snapshot
      // and a revert created in the same wall-clock second can swap.
      // Synthetic events (for snapshots that predate timeline tracking) are sorted
      // by createdAt and prepended.
      const events = [...synthesizeSnapshotEvents(snapshots, history.events, 'snapshot:'), ...history.events]

      return ok({
        events,
        recoveryPoints: history.recoveryPoints,
      })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('snapshot timeline failed', { path: this.currentProject.path, error: msg })
      return err(e instanceof HistoryMetadataReadError ? ErrorCode.HISTORY_METADATA_UNAVAILABLE : ErrorCode.SNAPSHOT_READ_FAILED, `Failed to read snapshot timeline: ${msg}`)
    }
  }

  // Per-node chronological history; see ./project/node-history for the walk.
  async nodeHistory(nodeId: string): Promise<Result<NodeHistory>> {
    if (!this.currentProject?.path) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    }
    const projectPath = this.currentProject.path

    // Synchronously trigger a backfill probe before any await. This is
    // idempotent — already-running backfills pass through, and an
    // up-to-date index is detected and exits inside the backfill run.
    // The synchronous flip of inProgress=true (when scheduled) prevents
    // the renderer from seeing stale "not in progress" state.
    this.backfill.schedule()

    let rowsBySnapshot = new Map<string, ReturnType<typeof this.history.nodeHistory>[number]>()
    try {
      const rows = this.history.nodeHistory(nodeId)
      rowsBySnapshot = new Map(rows.map(r => [r.snapshotId, r]))
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.warn('history index query failed', { nodeId, error: msg })
      // Continue with empty DB rows — synthesis from revert/recover events
      // can still surface SOME entries.
    }

    let persistedHistory: SnapshotHistoryState
    try {
      persistedHistory = this.readSnapshotHistory()
    } catch (e: unknown) {
      if (e instanceof HistoryMetadataReadError) {
        return err(ErrorCode.HISTORY_METADATA_UNAVAILABLE, e.message)
      }
      throw e
    }

    // Build the complete chronological event list. For projects that pre-date
    // this feature (or were generated by scripts that bypassed snapshotCreate),
    // history.events doesn't include entries for every git tag. Synthesize
    // missing snapshot events the same way snapshotTimeline does — without
    // this, those snapshots are invisible to the per-node history walker even
    // though their rows exist in history.db.
    let allEvents: SnapshotTimelineEvent[] = persistedHistory.events
    try {
      const listed = await this.git.listSnapshots(projectPath)
      const allSnapshots = withSnapshotMetadata(listed, this.readSnapshotHistory())
      allEvents = [...synthesizeSnapshotEvents(allSnapshots, persistedHistory.events, 'synthetic:'), ...persistedHistory.events]
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.warn('nodeHistory: synthetic event build failed; using events as-is', { error: msg })
    }

    const entries = await walkNodeHistory({
      nodeId,
      projectPath,
      events: allEvents,
      rowsBySnapshot,
      recoveryPoints: persistedHistory.recoveryPoints,
      readSnapshotDocument: snapshotId => this.git.readSnapshotDocument(projectPath, snapshotId),
      parse: raw => this.parseDocumentJson(raw),
      logger: this.logger,
    })

    return ok({ entries, backfillStatus: this.getHistoryIndexStatus() })
  }

  // ─── Compare and reports ────────────────────────────────────────────────────

  async snapshotCompare(a: string, b: string, scopeNodeId: unknown = null): Promise<Result<DiffEntry[]>> {
    if (!this.currentProject?.path) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    }
    try {
      const loaded = await this.loadAndDiff(a, b, scopeNodeId)
      if (!loaded.ok) return loaded as Result<DiffEntry[]>
      this.logger.info('snapshot compare complete', {
        path: this.currentProject.path,
        from: a,
        to: b,
        scopeNodeId: loaded.data.scope?.nodeId ?? null,
        diffCount: loaded.data.diffs.length,
      })
      return ok(loaded.data.diffs)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('snapshot compare failed', { path: this.currentProject.path, from: a, to: b, error: msg })
      return err(ErrorCode.SNAPSHOT_READ_FAILED, `Failed to compare snapshots: ${msg}`)
    }
  }

  async snapshotLoadCompare(a: string, b: string, scopeNodeId: unknown = null): Promise<Result<MergedTree>> {
    if (!this.currentProject?.path) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    }
    try {
      const loaded = await this.loadAndDiff(a, b, scopeNodeId)
      if (!loaded.ok) return loaded as Result<MergedTree>
      const { projectA, projectB, diffs, templateDiffs, scope } = loaded.data
      const merged = buildMergedTree(projectA, projectB, diffs, a, b, { scope, templateChanges: templateDiffs })
      this.logger.info('snapshot loadCompare complete', {
        path: this.currentProject.path,
        from: a,
        to: b,
        scopeNodeId: scope?.nodeId ?? null,
        nodeCount: merged.nodes.length,
      })
      return ok(merged)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('snapshot loadCompare failed', { path: this.currentProject.path, from: a, to: b, error: msg })
      return err(ErrorCode.SNAPSHOT_READ_FAILED, `Failed to load compare: ${msg}`)
    }
  }

  // Resolve a compare ref to a Project: the CURRENT_PROJECT_REF sentinel yields
  // the live in-memory current project (so the user can diff unsnapshotted work
  // against a snapshot); any other ref is read from git as a saved snapshot.
  private async resolveCompareProject(ref: string): Promise<Result<Project>> {
    if (isCurrentRef(ref)) {
      if (!this.currentProject) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
      return ok(this.currentProject)
    }
    const raw = await this.git.readSnapshotDocument(this.currentProject!.path!, ref)
    return this.parseDocumentJson(raw)
  }

  private loadAndDiff(a: string, b: string, scopeNodeId: unknown = null): Promise<Result<LoadedComparison>> {
    return loadAndDiff(ref => this.resolveCompareProject(ref), a, b, scopeNodeId)
  }

  /**
   * Build a shareable diff report (Markdown, CSV, or self-contained HTML) between two snapshots.
   * Re-runs the authoritative diff via loadAndDiff (renderer never decides
   * content) and returns the formatted string plus a suggested filename; the
   * IPC handler owns the save dialog + file write.
   */
  async buildReport(
    from: string,
    to: string,
    format: unknown,
    scopeNodeId: unknown = null,
  ): Promise<Result<{ content: string; suggestedName: string }>> {
    if (!this.currentProject?.path) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    }
    if (!isReportFormat(format)) {
      return err(ErrorCode.VALIDATION_FAILED, 'Report format must be markdown, csv, or html')
    }
    try {
      const loaded = await this.loadAndDiff(from, to, scopeNodeId)
      if (!loaded.ok) return loaded as Result<{ content: string; suggestedName: string }>

      // loadAndDiff returns no Snapshot records, so resolve metadata separately
      // for the report header (date + short commit hash).
      const listed = await this.snapshotList()
      if (!listed.ok) return listed as Result<{ content: string; suggestedName: string }>
      return ok(formatComparisonReport(loaded.data, from, to, format, listed.data, () => this.currentProject!.name))
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('report build failed', { path: this.currentProject.path, from, to, format, error: msg })
      return err(ErrorCode.SNAPSHOT_READ_FAILED, `Failed to build report: ${msg}`)
    }
  }

  // ─── Revert and recovery ────────────────────────────────────────────────────

  async snapshotRevert(request: SnapshotRevertRequest): Promise<Result<SnapshotRevertResult>> {
    return this.withHistoryOperation(() => this.performSnapshotRevert(request))
  }

  private async performSnapshotRevert(request: SnapshotRevertRequest): Promise<Result<SnapshotRevertResult>> {
    if (!this.currentProject?.path) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    }

    this.cancelAutosave()

    try {
      const name = request.name
      const note = request.note?.trim() || null
      const noteRequirement = await this.requiresRevertNote(name)
      if (!noteRequirement.ok) return noteRequirement as Result<SnapshotRevertResult>
      if (noteRequirement.data && !note) {
        return err(
          ErrorCode.VALIDATION_FAILED,
          'A revert note is required because this snapshot has later snapshots in the timeline.'
        )
      }

      const raw = await this.git.readSnapshotDocument(this.currentProject.path, name)
      const restored = this.parseDocumentJson(raw)
      if (!restored.ok) return restored as Result<SnapshotRevertResult>

      const previousProject = this.currentProject
      const restoredProject: Project = {
        ...restored.data,
        path: previousProject.path,
      }

      const eventId = uuidv7()
      this.beginHistoryOperation(`Revert to snapshot: ${name}`, {
        kind: 'snapshot-revert', eventId, targetId: name,
        expectedDocumentHash: hashDocument(serializeProjectForPersistence(restoredProject)),
      })
      const safetyRecoveryPoint = await createSafetyRecoveryPointIfNeeded(previousProject, this.git, this.logger)

      const searchResult = this.rebuildSearchIndex(restoredProject, 'rebuild')
      if (!searchResult.ok) {
        this.restoreSearchIndex(previousProject)
        this.abortHistoryOperation()
        return searchResult as Result<SnapshotRevertResult>
      }

      const writeResult = await this.writeDocument(restoredProject, { touchModified: false })
      if (!writeResult.ok) {
        this.currentProject = previousProject
        this.restoreSearchIndex(previousProject)
        this.abortHistoryOperation()
        return writeResult as Result<SnapshotRevertResult>
      }
      this.edits.clear()

      const event: SnapshotTimelineEvent = {
        id: eventId,
        type: 'revert',
        createdAt: new Date().toISOString(),
        targetSnapshotId: name,
        note,
        safetyRecoveryPointId: safetyRecoveryPoint?.id ?? null,
      }
      const history = structuredClone(this.historyBeforeOperation!)
      history.events.push(event)
      history.currentBaseSnapshotId = name
      history.pendingRevertEventId = event.id
      if (safetyRecoveryPoint) {
        history.recoveryPoints.push(safetyRecoveryPoint)
      }
      this.pruneRecoveryPoints(history)
      this.writeSnapshotHistory(history)

      this.logger.info('snapshot reverted', { name, path: this.currentProject.path, eventId: event.id })
      return ok({ event, safetyRecoveryPoint })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('snapshot revert failed', { name: request.name, path: this.currentProject.path, error: msg })
      return err(ErrorCode.GIT_COMMIT_FAILED, `Failed to revert snapshot: ${msg}`)
    }
  }

  async recoveryPointApply(request: RecoveryPointApplyRequest): Promise<Result<RecoveryPointApplyResult>> {
    return this.withHistoryOperation(() => this.performRecoveryPointApply(request))
  }

  private async performRecoveryPointApply(request: RecoveryPointApplyRequest): Promise<Result<RecoveryPointApplyResult>> {
    if (!this.currentProject?.path) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    }

    this.cancelAutosave()

    try {
      const history = structuredClone(this.historyBeforeOperation!)
      const recoveryPoint = history.recoveryPoints.find(point => point.id === request.id)
      if (!recoveryPoint) {
        return err(ErrorCode.VALIDATION_FAILED, `Recovery point not found: ${request.id}`)
      }

      const payloadPath = join(this.currentProject.path, ...recoveryPoint.payloadPath.split(/[\\/]/))
      if (!existsSync(payloadPath)) {
        return err(ErrorCode.SNAPSHOT_READ_FAILED, `Recovery document not found: ${recoveryPoint.payloadPath}`)
      }

      if (recoveryPoint.reason === 'reconciled' &&
          (lstatSync(join(this.currentProject.path, '.statekeep')).isSymbolicLink() ||
           lstatSync(join(this.currentProject.path, '.statekeep', 'recovery')).isSymbolicLink() ||
           !lstatSync(payloadPath).isFile() || lstatSync(payloadPath).isSymbolicLink())) {
        return err(ErrorCode.VALIDATION_FAILED, 'Added recovery files must remain regular local files.')
      }

      const recovered = this.parseDocumentJson(readFileSync(payloadPath, 'utf8'))
      if (!recovered.ok) return recovered as Result<RecoveryPointApplyResult>
      if (recovered.data.id !== this.currentProject.id) return err(ErrorCode.VALIDATION_FAILED, 'Recovery file belongs to another project.')

      const previousProject = this.currentProject
      const recoveredProject: Project = {
        ...recovered.data,
        path: previousProject.path,
      }

      const eventId = uuidv7()
      this.beginHistoryOperation(`Apply recovery: ${request.id}`, {
        kind: 'recovery-apply', eventId, targetId: request.id,
        expectedDocumentHash: hashDocument(serializeProjectForPersistence(recoveredProject)),
      })
      const safetyRecoveryPoint = await createSafetyRecoveryPointIfNeeded(previousProject, this.git, this.logger)

      const searchResult = this.rebuildSearchIndex(recoveredProject, 'rebuild')
      if (!searchResult.ok) {
        this.restoreSearchIndex(previousProject)
        this.abortHistoryOperation()
        return searchResult as Result<RecoveryPointApplyResult>
      }

      const writeResult = await this.writeDocument(recoveredProject, { touchModified: false })
      if (!writeResult.ok) {
        this.currentProject = previousProject
        this.restoreSearchIndex(previousProject)
        this.abortHistoryOperation()
        return writeResult as Result<RecoveryPointApplyResult>
      }
      this.edits.clear()

      const event: SnapshotTimelineEvent = {
        id: eventId,
        type: 'recover',
        createdAt: new Date().toISOString(),
        recoveryPointId: recoveryPoint.id,
        safetyRecoveryPointId: safetyRecoveryPoint?.id ?? null,
      }
      history.events.push(event)
      history.currentBaseSnapshotId = null
      history.pendingRevertEventId = event.id
      if (safetyRecoveryPoint) {
        history.recoveryPoints.push(safetyRecoveryPoint)
      }
      this.pruneRecoveryPoints(history, request.id)
      this.writeSnapshotHistory(history)

      this.logger.info('recovery point applied', { id: request.id, path: this.currentProject.path, eventId: event.id })
      return ok({ event, safetyRecoveryPoint })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('recovery point apply failed', { id: request.id, path: this.currentProject.path, error: msg })
      return err(ErrorCode.SNAPSHOT_READ_FAILED, `Failed to apply recovery point: ${msg}`)
    }
  }

  private async requiresRevertNote(targetSnapshotName: string): Promise<Result<boolean>> {
    if (!this.currentProject?.path) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    }
    const projectPath = this.currentProject.path
    return ok(await revertNoteRequired(this.readSnapshotHistory(), targetSnapshotName, () => this.git.listSnapshots(projectPath)))
  }

  private pruneRecoveryPoints(history: SnapshotHistoryState, protectedId: string | null = null): void {
    if (!this.currentProject?.path) return
    pruneRecoveryPoints(history, protectedId)
  }

  // ─── History operation journal ───────────────────────────────────────────────

  private operationStore(): HistoryOperationStore | null {
    return this.currentProject?.path ? new HistoryOperationStore(this.currentProject.path, this.currentProject.id) : null
  }

  private historyBytesOrNull(): Buffer | null {
    const project = this.currentProject
    if (!project?.path) throw new Error('No project open')
    return readHistoryBytesOrNull(this.operationStore()!, project.path)
  }

  private journalContext(): JournalContext {
    return {
      project: this.currentProject!,
      store: this.operationStore()!,
      historyBytesOrNull: () => this.historyBytesOrNull(),
      readHistory: bytes => this.readSnapshotHistory(bytes),
      parse: raw => this.parseDocumentJson(raw),
    }
  }

  private beginMetadataHistoryOperation(label: string,
    intent: Omit<MetadataHistoryOperationIntent, 'expectedDocumentHash'>, source: Buffer | null = null): PendingHistoryOperationV3 {
    const project = this.currentProject
    if (!project?.path) throw new Error('No project open')
    const document = readDocumentBytes(join(project.path, PROJECT_DOCUMENT_FILE))
    if (!document) throw new Error('The project document is missing.')
    const beforeHistory = this.historyBytesOrNull()
    if (intent.kind !== 'history-backup-restore') {
      if (!beforeHistory || !this.historyBeforeOperation) {
        throw new Error('History metadata changed. Review the operation again before changing it.')
      }
      const currentHistory = this.readSnapshotHistory(beforeHistory)
      if (JSON.stringify(currentHistory) !== JSON.stringify(this.historyBeforeOperation)) {
        throw new Error('History metadata changed. Review the operation again before changing it.')
      }
    }
    return this.operationStore()!.beginMetadata(label, serializeProjectForPersistence(project), beforeHistory,
      { ...intent, expectedDocumentHash: hashDocument(document) }, source)
  }

  private hasInterruptedHistory(): boolean { return this.operationStore()?.pending() ?? false }

  private interruptedHistoryError<T>(): Result<T> {
    return err(ErrorCode.HISTORY_OPERATION_PENDING, 'An unfinished history operation needs review. Saving and editing are paused; the pre-operation inventory is preserved.')
  }

  interruptedHistoryStatus(): Result<{ pending: boolean }> {
    return ok({ pending: (!this.historyOperationInProgress || this.classifyingInterruptedHistory) && this.hasInterruptedHistory() })
  }

  private scanInterruptedHistoryEvidence() {
    if (!this.currentProject?.path) throw new Error('No project is currently open.')
    return scanInterruptedHistoryEvidence(this.journalContext())
  }

  interruptedHistoryEvidencePreview(): Result<InterruptedHistoryEvidencePreview> {
    if (!this.currentProject?.path) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    if (this.hasInterruptedHistory()) return this.interruptedHistoryError()
    if (this.historyOperationInProgress || this.archiveBusy) return err(ErrorCode.VALIDATION_FAILED, 'Wait for the current history or archive operation to finish.')
    try { return ok(this.scanInterruptedHistoryEvidence().preview) }
    catch (error) {
      return err(error instanceof HistoryMetadataReadError ? ErrorCode.HISTORY_METADATA_UNAVAILABLE : ErrorCode.SNAPSHOT_READ_FAILED,
        `Could not inspect interrupted-operation evidence: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  deleteInterruptedHistoryEvidence(request: unknown): Result<InterruptedHistoryEvidenceDeleteResult> {
    if (!this.currentProject?.path) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    if (this.hasInterruptedHistory()) return this.interruptedHistoryError()
    if (this.historyOperationInProgress || this.archiveBusy) return err(ErrorCode.VALIDATION_FAILED, 'Wait for the current history or archive operation to finish.')
    if (!request || typeof request !== 'object' || !('id' in request) || typeof request.id !== 'string' ||
        !('token' in request) || typeof request.token !== 'string') {
      return err(ErrorCode.VALIDATION_FAILED, 'Review retained evidence before deleting it.')
    }
    this.historyOperationInProgress = true
    try {
      const scanned = this.scanInterruptedHistoryEvidence()
      if (!scanned.preview.historyReadable) {
        return err(ErrorCode.HISTORY_METADATA_UNAVAILABLE, 'Restore readable history metadata before deleting retained evidence.')
      }
      const group = scanned.preview.groups.find(item => item.id === request.id)
      const candidate = scanned.candidates.get(request.id)
      if (!group || !candidate || group.token !== request.token) {
        return err(ErrorCode.VALIDATION_FAILED, 'The evidence or recovery registrations changed. Review retained evidence again.')
      }
      if (group.registeredAsRecoveryPoint) {
        return err(ErrorCode.VALIDATION_FAILED, 'Remove this inventory from Additional recovery files before deleting its evidence.')
      }
      return ok(this.operationStore()!.removeRetained(candidate))
    } catch (error) {
      return err(error instanceof RetainedEvidenceChangedError ? ErrorCode.VALIDATION_FAILED : ErrorCode.SNAPSHOT_READ_FAILED,
        `Could not delete interrupted-operation evidence: ${error instanceof Error ? error.message : String(error)}`)
    } finally { this.historyOperationInProgress = false }
  }

  private beginHistoryOperation(label: string, intent: HistoryOperationIntent): void {
    const store = this.operationStore()
    if (!store || !this.currentProject) throw new Error('No project open')
    store.begin(label, serializeProjectForPersistence(this.currentProject), JSON.stringify(this.historyBeforeOperation ?? this.readSnapshotHistory(), null, 2), intent)
    this.backfill.cancel()
  }

  private abortHistoryOperation(): void {
    try { this.operationStore()!.finish() }
    catch (error) { this.logger.warn('rolled-back history operation evidence needs review', { error: String(error) }) }
    if (!this.hasInterruptedHistory() && !this.documentSaveError) this.scheduleAutosave()
  }

  private async finishProvenHistoryOperation(): Promise<void> {
    const store = this.operationStore()
    if (!store?.pending() || !this.currentProject?.path) return
    const alreadyBusy = this.historyOperationInProgress
    this.historyOperationInProgress = true
    this.classifyingInterruptedHistory = true
    try {
      await finishIfProvenComplete({ ...this.journalContext(), store, git: this.git, logger: this.logger })
    } finally {
      this.classifyingInterruptedHistory = false
      this.historyOperationInProgress = alreadyBusy
    }
  }

  private interruptedHistoryCandidate() {
    const store = this.operationStore()
    if (!store || !this.currentProject) throw new Error('No project open')
    return interruptedHistoryCandidate({ ...this.journalContext(), store })
  }

  reviewInterruptedHistory(): Result<InterruptedHistoryPreview> {
    if (this.historyOperationInProgress || this.archiveBusy) return err(ErrorCode.VALIDATION_FAILED, 'Wait for the current operation to finish.')
    try {
      const candidate = this.interruptedHistoryCandidate()
      return ok({ token: candidate.token, label: candidate.evidence.record.label, startedAt: candidate.evidence.record.startedAt,
        beforeNodeCount: candidate.before.nodes.length, currentNodeCount: this.currentProject!.nodes.length,
        recoveryPath: join(candidate.store.recoveryPath, candidate.evidence.record.inventoryFile),
        metadataOnly: candidate.metadataOnly, currentHistoryAvailable: candidate.currentHistoryBytes !== null,
        historyReadable: candidate.historyReadable })
    } catch (error) { return err(ErrorCode.HISTORY_OPERATION_PENDING, `Could not review unfinished history: ${String(error)}. Preserve ${this.operationStore()?.pendingPath} and its recovery files for manual recovery; restore readable history metadata if necessary.`) }
  }

  async acknowledgeInterruptedHistory(request: unknown): Promise<Result<Project>> {
    if (this.historyOperationInProgress || this.archiveBusy) return err(ErrorCode.VALIDATION_FAILED, 'Wait for the current operation to finish.')
    if (!request || typeof request !== 'object' || !('token' in request) || typeof request.token !== 'string') return err(ErrorCode.VALIDATION_FAILED, 'Review the unfinished operation first.')
    this.historyOperationInProgress = true
    try {
      const candidate = this.interruptedHistoryCandidate()
      if (candidate.token !== request.token) return err(ErrorCode.VALIDATION_FAILED, 'The project or evidence changed. Review the unfinished operation again.')
      this.assertDocumentUnchanged(this.currentProject!.path!)
      const id = uuidv7()
      writeHistoryFile(join(candidate.store.recoveryPath, `recovery-${id}-continued.document.json`), candidate.current)
      if (candidate.metadataOnly || candidate.history === null) {
        if (candidate.currentHistoryBytes !== null) {
          writeHistoryFile(join(candidate.store.recoveryPath, `recovery-${id}-continued-history.json`), candidate.currentHistoryBytes)
        }
        if (!candidate.metadataOnly) {
          const saved = await this.writeDocument(this.currentProject!)
          if (!saved.ok) return saved as Result<Project>
        }
        candidate.store.finish(true)
        if (candidate.historyReadable) this.backfill.schedule()
        if (candidate.metadataOnly) this.scheduleAutosave()
        else { this.cancelAutosave(); this.edits.clear() }
        return ok(this.currentProject!)
      }
      writeHistoryFile(join(candidate.store.recoveryPath, `recovery-${id}-continued-history.json`), JSON.stringify(candidate.history, null, 2))
      // No Git replay and no invented timeline event. Preserve the current
      // inventory and relinquish lineage assumptions that may be incomplete.
      const saved = await this.writeDocument(this.currentProject!)
      if (!saved.ok) return saved as Result<Project>
      this.historyBeforeOperation = candidate.history!
      this.writeSnapshotHistory({ ...candidate.history!, currentBaseSnapshotId: null, pendingRevertEventId: null }, { deleteRemovedPayloads: false })
      candidate.store.finish(true)
      this.cancelAutosave()
      this.edits.clear()
      this.backfill.schedule()
      return ok(this.currentProject!)
    } catch (error) { return err(ErrorCode.HISTORY_OPERATION_PENDING, `Could not continue after interrupted history: ${String(error)}`) }
    finally { this.historyOperationInProgress = false; this.historyBeforeOperation = null }
  }

  // ─── External document changes ───────────────────────────────────────────────

  private retainCurrentDocumentVersion(): void {
    const currentPath = join(this.currentProject!.path!, PROJECT_DOCUMENT_FILE)
    for (const path of this.documentVersions.keys()) {
      if (path !== currentPath) this.documentVersions.delete(path)
    }
    if (this.conflictLocalCopy?.path !== this.currentProject!.path) this.conflictLocalCopy = null
  }

  private assertDocumentUnchanged(projectPath: string, expected?: string | null): void {
    const path = join(projectPath, PROJECT_DOCUMENT_FILE)
    const baseline = expected === undefined ? this.documentVersions.get(path) ?? null : expected
    try {
      if (readDocumentHash(path) === baseline) return
    } catch { /* An unreadable file must never be replaced blindly. */ }
    let message = 'The project file changed outside Statekeep or is no longer readable. Saving is paused. Review both versions before continuing.'
    if (this.currentProject?.path === projectPath) {
      try {
        const local = serializeProjectForPersistence(this.currentProject)
        const hash = hashDocument(local)
        if (this.conflictLocalCopy?.path !== projectPath || this.conflictLocalCopy.hash !== hash ||
            readDocumentHash(this.conflictLocalCopy.file) !== hash) {
          const directory = this.conflictRecoveryDirectory(projectPath)
          const file = join(directory, `recovery-${uuidv7()}-local.document.json`)
          writeHistoryFile(file, local)
          this.conflictLocalCopy = { path: projectPath, hash, file }
        }
        message += ` Your current inventory is preserved at ${this.conflictLocalCopy.file}.`
      } catch (error) { message += ` Could not preserve a local copy: ${String(error)}. Keep this project open until resolved.` }
    }
    this.documentSaveError = { path: projectPath, message }
    throw new ExternalDocumentChangedError(message)
  }

  private conflictRecoveryDirectory(projectPath: string): string {
    if (!existsSync(projectPath) || !lstatSync(projectPath).isDirectory() || lstatSync(projectPath).isSymbolicLink()) throw new Error('The project folder is missing, moved, or linked. Restore its original location before continuing.')
    const metadata = join(projectPath, '.statekeep')
    const recovery = join(metadata, 'recovery')
    for (const path of [metadata, recovery]) {
      if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw new Error('Recovery copies require regular local directories.')
    }
    mkdirSync(recovery, { recursive: true })
    return recovery
  }

  checkExternalDocument(): void {
    if (!this.currentProject?.path || this.archiveBusy || this.historyOperationInProgress) return
    try { this.assertDocumentUnchanged(this.currentProject.path); this.documentSaveError = null } catch { /* Status carries the error to the renderer. */ }
  }

  documentSaveStatus(): Result<{ message: string | null }> {
    return ok({ message: this.documentSaveError?.path === this.currentProject?.path ? this.documentSaveError?.message ?? null : null })
  }

  private externalDocumentCandidate() {
    const project = this.currentProject
    if (!project?.path) throw new Error('No project is currently open')
    const path = join(project.path, PROJECT_DOCUMENT_FILE)
    const bytes = readDocumentBytes(path)
    const externalHash = bytes === null ? null : hashDocument(bytes)
    if (externalHash === this.documentVersions.get(path)) throw new Error('The project file no longer differs from the last saved version. Try saving again.')
    const local = serializeProjectForPersistence(project)
    const parsed = bytes === null ? null : this.parseDocumentJson(bytes.toString('utf8'))
    const external = parsed?.ok && parsed.data.id === project.id ? parsed.data : null
    const token = hashDocument(JSON.stringify([project.path, project.id, this.documentVersions.get(path), externalHash, hashDocument(local)]))
    const description = bytes === null ? 'The project file is missing.' : !parsed?.ok ? 'The external file is not a supported valid project.' : !external ? 'The external file belongs to another project.' : 'The external inventory is valid for this project.'
    return { project, bytes, externalHash, local, external, token, description }
  }

  reviewExternalDocument(): Result<ExternalDocumentPreview> {
    try {
      const candidate = this.externalDocumentCandidate()
      return ok({ token: candidate.token, localNodeCount: candidate.project.nodes.length,
        externalNodeCount: candidate.external?.nodes.length ?? null, canLoadExternal: candidate.external !== null,
        externalDescription: candidate.description })
    } catch (error) { return err(ErrorCode.EXTERNAL_DOCUMENT_CHANGED, String(error)) }
  }

  async resolveExternalDocument(request: unknown): Promise<Result<Project>> {
    if (this.historyOperationInProgress || this.archiveBusy) return err(ErrorCode.VALIDATION_FAILED, 'Wait for the current operation to finish.')
    if (!request || typeof request !== 'object' || !('token' in request) || typeof request.token !== 'string' ||
        !('choice' in request) || (request.choice !== 'keep-local' && request.choice !== 'load-external')) return err(ErrorCode.VALIDATION_FAILED, 'Review both versions before choosing one.')
    this.historyOperationInProgress = true
    try {
      const candidate = this.externalDocumentCandidate()
      if (request.token !== candidate.token) return err(ErrorCode.VALIDATION_FAILED, 'The versions changed. Review them again.')
      if (request.choice === 'load-external' && !candidate.external) return err(ErrorCode.VALIDATION_FAILED, 'The external file cannot be loaded.')
      const path = candidate.project.path!
      const recovery = this.conflictRecoveryDirectory(path)
      const history = request.choice === 'load-external' ? this.readSnapshotHistory() : null
      this.historyBeforeOperation = history
      if (history && existsSync(snapshotHistoryPath(path))) new HistoryBackupStore(path, candidate.project.id).save(history)
      const id = uuidv7()
      writeHistoryFile(join(recovery, `recovery-${id}-local.document.json`), candidate.local)
      if (candidate.bytes !== null) writeHistoryFile(join(recovery, `recovery-${id}-external.document.json`), candidate.bytes)
      // Copy both versions first, then recheck external bytes immediately
      // before any replacement or in-memory transition.
      this.assertDocumentUnchanged(path, candidate.externalHash)
      if (request.choice === 'keep-local') {
        const saved = await this.writeDocument(candidate.project, { expectedDocumentHash: candidate.externalHash })
        if (!saved.ok) return saved as Result<Project>
      } else {
        const next = withProjectWarnings({ ...candidate.external!, path }, collectProjectWarnings(path))
        const indexed = this.rebuildSearchIndex(next, 'rebuild')
        if (!indexed.ok) return indexed as Result<Project>
        try {
          this.writeSnapshotHistory({ ...history!, currentBaseSnapshotId: null, pendingRevertEventId: null })
        } catch (error) { this.restoreSearchIndex(candidate.project); throw error }
        this.cancelAutosave()
        this.currentProject = next
        this.edits.clear()
        this.documentVersions.set(join(path, PROJECT_DOCUMENT_FILE), candidate.externalHash)
      }
      this.documentSaveError = null
      return ok(request.choice === 'load-external' ? withLoadWarnings(this.currentProject!, collectLoadWarnings(candidate.external!)) : this.currentProject!)
    } catch (error) {
      return err(ErrorCode.EXTERNAL_DOCUMENT_CHANGED, `Could not resolve external change: ${error instanceof Error ? error.message : String(error)}`)
    } finally { this.historyOperationInProgress = false; this.historyBeforeOperation = null }
  }

  // ─── Autosave ───────────────────────────────────────────────────────────────

  private async flushPendingAutosave(): Promise<Result<void>> {
    this.cancelAutosave()
    if (!this.currentProject) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    return this.writeDocument(this.currentProject)
  }

  private scheduleAutosave(): void {
    this.cancelAutosave()
    this.autosaveTimer = setTimeout(() => {
      this.saveProject().then(result => {
        if (!result.ok) {
          this.logger.error('autosave failed', { error: result.error.message })
        }
      })
    }, AUTOSAVE_DEBOUNCE_MS)
  }

  cancelAutosave(): void {
    if (this.autosaveTimer !== null) {
      clearTimeout(this.autosaveTimer)
      this.autosaveTimer = null
    }
  }

  // ─── Commit, persistence, and index seams ───────────────────────────────────
  // writeDocument, writeSnapshotHistory, rebuildSearchIndex, and
  // restoreSearchIndex stay methods on purpose: they are the failure-injection
  // seams the interruption tests spy on.

  private parseDocumentJson(raw: string): Result<Project> {
    return parseProjectDocument(raw, this.logger)
  }

  private commitPlannedMutation(planned: Result<ProjectMutation>): Result<Project> {
    if (!planned.ok) return planned
    return this.commitMutation(planned.data)
  }

  private commitMutation({ next, label, search }: ProjectMutation): Result<Project> {
    return this.commitProjectMutation(next, label, () => this.applySearchUpdate(next, search))
  }

  private applySearchUpdate(project: Project, update: SearchUpdate): void {
    if (update.rebuild) {
      this.search.rebuild(project)
      return
    }
    const projectPath = project.path!
    if (update.remove) this.search.deleteNodes(projectPath, update.remove)
    for (const node of update.upsert ?? []) this.search.upsertNode(projectPath, node)
  }

  private commitProjectMutation(
    nextProject: Project,
    label: string,
    syncSearch: () => void
  ): Result<Project> {
    if (this.hasInterruptedHistory()) return this.interruptedHistoryError()
    const previousProject = this.currentProject
    if (!previousProject?.path) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project open')
    }
    if (this.documentSaveError?.path === previousProject.path) return err(ErrorCode.EXTERNAL_DOCUMENT_CHANGED, this.documentSaveError.message)

    if (this.historyOperationInProgress) {
      return err(ErrorCode.VALIDATION_FAILED, 'Wait for the snapshot or recovery operation to finish.')
    }
    const edit = this.edits.prepare(previousProject, nextProject, label)
    if (!edit) return ok(previousProject)

    try {
      syncSearch()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.restoreSearchIndex(previousProject)
      this.logger.error('search index sync failed', { path: previousProject.path, error: msg })
      return err(ErrorCode.SQLITE_CAPABILITY, `Failed to update search index: ${msg}`)
    }

    this.edits.record(edit)
    this.currentProject = nextProject
    this.scheduleAutosave()
    return ok(nextProject)
  }

  private rebuildSearchIndex(project: Project, action: 'initialize' | 'rebuild'): Result<void> {
    try {
      this.search.rebuild(project)
      return ok(undefined as void)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error(`search index ${action} failed`, { path: project.path, error: msg })
      return err(
        ErrorCode.SQLITE_CAPABILITY,
        `Failed to ${action} search index: ${msg}`
      )
    }
  }

  private restoreSearchIndex(project: Project | null): void {
    if (!project) {
      this.search.close()
      return
    }

    const rebuilt = this.rebuildSearchIndex(project, 'rebuild')
    if (!rebuilt.ok) {
      this.search.close()
    }
  }

  private readSnapshotHistory(bytes?: Buffer): SnapshotHistoryState {
    const project = this.currentProject
    if (!project?.path) return emptySnapshotHistory()
    return readSnapshotHistoryFile(project.path, project.id, this.logger, bytes)
  }

  private writeSnapshotHistory(history: SnapshotHistoryState, { deleteRemovedPayloads = true }: { deleteRemovedPayloads?: boolean } = {}): void {
    const project = this.currentProject
    if (!project?.path) return
    writeSnapshotHistoryFile(project.path, project.id, history,
      this.historyBeforeOperation ?? emptySnapshotHistory(), deleteRemovedPayloads, this.logger)
  }

  // Atomic write: tmp then rename.
  private async writeDocument(
    project: Project,
    options: { touchModified?: boolean; expectedDocumentHash?: string | null } = {}
  ): Promise<Result<void>> {
    if (!project.path) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'Project has no path — cannot save')
    }
    const documentPath = join(project.path, PROJECT_DOCUMENT_FILE)
    const tmpPath = `${documentPath}.${uuidv7()}.tmp`
    const touchModified = options.touchModified ?? true
    try {
      this.assertDocumentUnchanged(project.path, options.expectedDocumentHash)
      const persistedProject = {
        ...project,
        modified: touchModified ? new Date().toISOString() : project.modified,
      }
      const serialized = serializeProjectForPersistence(persistedProject)
      writeFileSync(tmpPath, serialized, 'utf8')
      this.assertDocumentUnchanged(project.path, options.expectedDocumentHash)
      renameSync(tmpPath, documentPath)
      this.documentVersions.set(documentPath, hashDocument(serialized))
      this.documentSaveError = null
      if (this.currentProject?.path === project.path && this.currentProject.id === project.id) {
        this.currentProject = persistedProject
      }
      this.logger.debug('project saved', { path: project.path })
      return ok(undefined as void)
    } catch (e: unknown) {
      if (e instanceof ExternalDocumentChangedError) {
        return err(ErrorCode.EXTERNAL_DOCUMENT_CHANGED, e.message)
      }
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('project save failed', { path: project.path, error: msg })
      return err(ErrorCode.AUTOSAVE_WRITE_FAILED, `Failed to save project: ${msg}`)
    } finally { try { unlinkSync(tmpPath) } catch { /* Only remove our temporary file. */ } }
  }

  // ─── History index ──────────────────────────────────────────────────────────

  private openHistoryIndex(projectPath: string): void {
    try {
      this.history.open(projectPath)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.warn('history index open failed', { path: projectPath, error: msg })
    }
  }

  // Record one snapshot's per-node state in the history index. Best-effort:
  // if anything fails (git read, parse, DB insert), log and continue. Backfill
  // on next project open will catch up.
  private async recordSnapshotInHistory(
    snapshotId: string,
    project: Project,
    history: SnapshotHistoryState,
  ): Promise<void> {
    if (!project.path) return
    try {
      // Authoritative chronological order comes from history.events push
      // order, not git tag creatordate (which is second-precision and
      // unstable for ties).
      const snapshotIdsInOrder = history.events
        .filter(e => e.type === 'snapshot' && e.snapshotId)
        .map(e => e.snapshotId as string)
      const myIndex = snapshotIdsInOrder.lastIndexOf(snapshotId)
      const snapshotOrder = myIndex >= 0 ? myIndex : snapshotIdsInOrder.length
      const previousSnapshotName = myIndex > 0 ? snapshotIdsInOrder[myIndex - 1] : null

      let previousProject: Project | null = null
      if (previousSnapshotName) {
        const raw = await this.git.readSnapshotDocument(project.path, previousSnapshotName)
        const parsed = this.parseDocumentJson(raw)
        if (parsed.ok) previousProject = parsed.data
      }

      this.history.recordSnapshot({
        snapshotId, snapshotOrder, project, previousProject,
      })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.warn('history index record failed; backfill will retry on next open', {
        snapshotId, error: msg,
      })
    }
  }
}

