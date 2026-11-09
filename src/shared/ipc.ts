// IPC channel definitions. This file is the single source of truth
// for the contract between renderer and main process.
//
// Rules:
//   1. No channel exists unless it is listed here.
//   2. Add new channels here before implementing them.
//   3. All responses use Result<T> — never throw across the IPC boundary.

import type {
  Project,
  EditHistoryState,
  ProjectNode,
  NodeTemplate,
  Snapshot,
  DiffEntry,
  SearchResultPage,
  GitStatus,
  Result,
  NodeHistory,
  NodeHistoryIndexStatus,
  RecoveryPointApplyRequest,
  RecoveryPointApplyResult,
  SnapshotRevertRequest,
  SnapshotRevertResult,
  SnapshotTimeline,
  HistoryBackupStatus,
  HistoryBackupRestoreResult,
  RecoveryFilePreview,
  ProjectArchivePreview,
  ExternalDocumentPreview,
  InterruptedHistoryPreview,
  InterruptedHistoryEvidencePreview,
  InterruptedHistoryEvidenceDeleteResult,
  RecoveryPoint,
  ImportMapping,
  ImportInspect,
  ImportPlan,
  ImportResult,
  NetboxInspect,
  NetboxImportOptions,
  NetboxImportPlan,
  NetboxImportResult,
} from './types'
import type { MergedTree } from './merged-tree'
import type { ReportFormat } from './report'
import type { MenuCommandId, MenuCommandState } from './menu-commands'
import type { DesktopChromeInfo } from './desktop-chrome'
import type { AppearancePreference } from './theme'
import type { BatchPropertyUpdateRequest, BatchPropertyUpdateResult } from './batch-properties'
import type { InventoryFilters } from './inventory-filters'
import type { InventoryExportRequest, InventoryTablePage, InventoryTableRequest } from './inventory-table'

// Channel name constants — use these everywhere, never raw strings.
export const IPC = {
  HISTORY_OPERATION_STATUS: 'historyOperation:status',
  HISTORY_OPERATION_REVIEW: 'historyOperation:review',
  HISTORY_OPERATION_ACKNOWLEDGE: 'historyOperation:acknowledge',
  HISTORY_OPERATION_EVIDENCE_PREVIEW: 'historyOperation:evidencePreview',
  HISTORY_OPERATION_EVIDENCE_DELETE: 'historyOperation:evidenceDelete',
  DOCUMENT_SAVE_STATUS: 'project:saveStatus',
  DOCUMENT_CONFLICT_REVIEW: 'project:reviewExternalChange',
  DOCUMENT_CONFLICT_RESOLVE: 'project:resolveExternalChange',
  ARCHIVE_EXPORT: 'archive:export',
  ARCHIVE_INSPECT: 'archive:inspect',
  ARCHIVE_RESTORE: 'archive:restore',
  PROJECT_CREATE:      'project:create',
  PROJECT_OPEN:        'project:open',
  PROJECT_OPEN_EXAMPLE: 'project:openExample',
  PROJECT_SAVE:        'project:save',
  PROJECT_GET_CURRENT: 'project:getCurrent',
  PROJECT_CLOSE:       'project:close',
  PROJECT_UNDO:        'project:undo',
  PROJECT_REDO:        'project:redo',
  PROJECT_EDIT_HISTORY: 'project:editHistory',
  TEXT_UNDO_REDO:      'text:undoRedo',
  PROJECT_OPENED_FROM_OS: 'project:openedFromOs',
  NODE_CREATE:         'node:create',
  NODE_DUPLICATE:      'node:duplicate',
  NODE_BATCH_UPDATE_PROPERTIES: 'node:batchUpdateProperties',
  NODE_UPDATE:         'node:update',
  NODE_DELETE:         'node:delete',
  NODE_MOVE:           'node:move',
  NODE_HISTORY:        'node:history',
  NODE_HISTORY_BACKFILL_STATUS: 'node:historyBackfillStatus',
  NODE_HISTORY_REINDEX: 'node:history:reindex',
  TEMPLATE_CREATE:     'template:create',
  TEMPLATE_UPDATE:     'template:update',
  TEMPLATE_DELETE:     'template:delete',
  IMPORT_INSPECT:      'import:inspect',
  IMPORT_PLAN:         'import:plan',
  IMPORT_APPLY:        'import:apply',
  IMPORT_NETBOX_INSPECT: 'import:netbox:inspect',
  IMPORT_NETBOX_PLAN:    'import:netbox:plan',
  IMPORT_NETBOX_APPLY:   'import:netbox:apply',
  SEARCH_QUERY:        'search:query',
  INVENTORY_TABLE_QUERY: 'inventory:tableQuery',
  INVENTORY_EXPORT_CSV: 'inventory:exportCsv',
  SNAPSHOT_CREATE:     'snapshot:create',
  SNAPSHOT_LIST:       'snapshot:list',
  SNAPSHOT_COMPARE:      'snapshot:compare',
  SNAPSHOT_LOAD_COMPARE: 'snapshot:loadCompare',
  SNAPSHOT_REVERT:       'snapshot:revert',
  SNAPSHOT_TIMELINE:     'snapshot:timeline',
  HISTORY_BACKUP_STATUS: 'history:backupStatus',
  HISTORY_BACKUP_RESTORE: 'history:restoreBackup',
  RECOVERY_FILES_PREVIEW: 'recovery:filesPreview',
  RECOVERY_FILES_ADOPT: 'recovery:filesAdopt',
  RECOVERY_FILES_FORGET: 'recovery:filesForget',
  RECOVERY_APPLY:        'recovery:apply',
  GIT_CHECK:           'git:check',
  REPORT_EXPORT:       'report:export',
  REPORT_BUILD:        'report:build',
  // UI utility channels (not domain operations)
  DIALOG_OPEN_FOLDER:  'dialog:openFolder',
  DIALOG_OPEN_FILE:    'dialog:openFile',
  // Native menu notifications. These are one-way UI events, not domain calls.
  MENU_COMMAND:        'menu:command',
  MENU_STATE_UPDATE:   'menu:stateUpdate',
  WINDOW_FOCUS_GET:    'window:focusGet',
  WINDOW_FOCUS_CHANGED: 'window:focusChanged',
  RECENT_PROJECTS_LIST: 'recentProjects:list',
  SETTINGS_GET:        'settings:get',
  SETTINGS_UPDATE_WORKSPACE: 'settings:updateWorkspace',
  SETTINGS_GET_PREFERENCES: 'settings:getPreferences',
  SETTINGS_UPDATE_PREFERENCES: 'settings:updatePreferences',
  SETTINGS_PREFERENCES_CHANGED: 'settings:preferencesChanged',
  SETTINGS_RESET_LAYOUT: 'settings:resetLayout',
  SETTINGS_LAYOUT_RESET: 'settings:layoutReset',
  SETTINGS_CLOSE_WINDOW: 'settings:closeWindow',
} as const

export interface LastWorkspaceProject {
  path: string
  name: string
  exists: boolean
}

export interface WorkspaceSettings {
  treeWidth: number
  tableWidth: number
  panelWidth: number
  lastOpenDirectory: string | null
  lastCreateDirectory: string | null
  lastProject: LastWorkspaceProject | null
}

export interface WorkspaceSettingsPatch {
  treeWidth?: number
  tableWidth?: number
  panelWidth?: number
  lastOpenDirectory?: string | null
  lastCreateDirectory?: string | null
}

export type LaunchBehavior = 'project-hub' | 'reopen-last-project'

export interface AppPreferences {
  launchBehavior: LaunchBehavior
  appearance: AppearancePreference
}

export interface AppPreferencesPatch {
  launchBehavior?: LaunchBehavior
  appearance?: Partial<AppearancePreference>
}

/** A project shown in Statekeep's desktop project hub and native File > Open Recent menu. */
export interface RecentProject {
  path: string
  name: string
  openedAt: string
  exists: boolean
}

export type FolderDialogPurpose = 'open-project' | 'create-project'

// Typed API surface exposed on window.api by the preload script.
// Renderer code should only interact with main process through this interface.
//
// Node mutation methods return Result<Project> — the full updated project state
// after each mutation. The renderer replaces its local store entirely, which
// eliminates any possibility of partial-sync bugs.
export interface StatekeepAPI {
  historyOperation: {
    status(): Promise<Result<{ pending: boolean }>>
    review(): Promise<Result<InterruptedHistoryPreview>>
    acknowledge(request: { token: string }): Promise<Result<Project>>
    evidencePreview(): Promise<Result<InterruptedHistoryEvidencePreview>>
    deleteEvidence(request: { id: string; token: string }): Promise<Result<InterruptedHistoryEvidenceDeleteResult>>
  }
  documentConflict: {
    status(): Promise<Result<{ message: string | null }>>
    review(): Promise<Result<ExternalDocumentPreview>>
    resolve(request: { token: string; choice: 'keep-local' | 'load-external' }): Promise<Result<Project>>
  }
  archive: {
    export(): Promise<Result<{ path: string } | null>>
    inspect(): Promise<Result<ProjectArchivePreview | null>>
    restore(request: { token: string }): Promise<Result<{ path: string } | null>>
  }
  platform: DesktopChromeInfo
  project: {
    create(name: string, parentPath: string): Promise<Result<Project>>
    open(path: string): Promise<Result<Project>>
    /** Creates (once) and opens Statekeep's user-owned sample project. */
    openExample(): Promise<Result<Project>>
    save(): Promise<Result<void>>
    getCurrent(): Promise<Result<Project | null>>
    close(): Promise<Result<void>>
    undo(): Promise<Result<Project>>
    redo(): Promise<Result<Project>>
    editHistory(): Promise<Result<EditHistoryState>>
    onOpenedFromOs(handler: (result: Result<Project>) => void): () => void
  }
  text: {
    /** Native editing in the calling renderer only; never changes project history. */
    undoRedo(direction: 'undo' | 'redo'): Promise<Result<void>>
  }
  node: {
    /** Create a child node under parentId, optionally bound to a template. Returns full updated Project. */
    create(parentId: string, name: string, templateId?: string | null): Promise<Result<Project>>
    /** Copy a non-root node and its descendants immediately after the source sibling. */
    duplicate(id: string, name: string): Promise<Result<Project>>
    /** Atomically set or clear one property across two or more nodes. */
    batchUpdateProperties(request: BatchPropertyUpdateRequest): Promise<Result<BatchPropertyUpdateResult>>
    /** Update node name, properties, and/or template binding. Returns full updated Project. */
    update(
      id: string,
      changes: {
        name?: string
        properties?: Record<string, string | number | boolean | null>
        templateId?: string | null
      }
    ): Promise<Result<Project>>
    /**
     * Delete node and all its descendants. Returns full updated Project.
     * Blocked by default when a surviving node's `reference` property — or a
     * template `reference` field default — points into the deletion set; the
     * blocking `ReferenceBlocker[]` rides in the error context. Pass
     * `{ unlinkReferences: true }` to clear those references/defaults and force
     * the delete.
     */
    delete(id: string, options?: { unlinkReferences?: boolean }): Promise<Result<Project>>
    /** Move node to newParentId (appended as last child) or reorder within same parent. */
    move(id: string, newParentId: string, newOrder: number): Promise<Result<Project>>
    /** Chronological history of one node across all snapshots, plus revert/recover events that changed it. */
    history(nodeId: string): Promise<Result<NodeHistory>>
    /** Status of the background per-node history backfill (populated on project open). */
    historyBackfillStatus(): Promise<Result<NodeHistoryIndexStatus>>
    /** Re-run per-node history indexing for any incomplete snapshots. */
    historyReindex(): Promise<Result<NodeHistoryIndexStatus>>
  }
  template: {
    /** Create a new node template (id must be a unique slug). Returns full updated Project. */
    create(id: string, template: NodeTemplate): Promise<Result<Project>>
    /** Update a template; rejected if it would invalidate a bound node's value. Returns full updated Project. */
    update(id: string, changes: Partial<NodeTemplate>): Promise<Result<Project>>
    /** Delete a template; bound nodes are unbound but keep their values. Returns full updated Project. */
    delete(id: string): Promise<Result<Project>>
  }
  import: {
    /** First look at a CSV: headers, a sample, and total row count. */
    inspect(path: string): Promise<Result<ImportInspect>>
    /** Full-file validation given a mapping: accepted/skipped/warning counts + capped issues. */
    plan(path: string, mapping: ImportMapping): Promise<Result<ImportPlan>>
    /** Apply the import (re-plans authoritatively). Returns the updated Project + a summary. */
    apply(path: string, mapping: ImportMapping): Promise<Result<{ project: Project; summary: ImportResult }>>
    /** First look at a NetBox dumpdata JSON: site/location/rack/device counts. */
    netboxInspect(path: string): Promise<Result<NetboxInspect>>
    /** Plan a NetBox import under a base parent: per-type counts + capped issues. */
    netboxPlan(path: string, options: NetboxImportOptions): Promise<Result<NetboxImportPlan>>
    /** Apply a NetBox import (re-plans authoritatively). Returns the updated Project + a summary. */
    netboxApply(
      path: string,
      options: NetboxImportOptions,
    ): Promise<Result<{ project: Project; summary: NetboxImportResult }>>
  }
  search: {
    query(
      query: string,
      offset?: number,
      limit?: number,
      filters?: InventoryFilters,
    ): Promise<Result<SearchResultPage>>
  }
  inventory: {
    query(request: InventoryTableRequest): Promise<Result<InventoryTablePage>>
    exportCsv(request: InventoryExportRequest): Promise<Result<{ savedPath: string | null; rowCount: number }>>
  }
  snapshot: {
    recoveryFilesPreview(): Promise<Result<RecoveryFilePreview>>
    adoptRecoveryFile(request: { token: string; name: string }): Promise<Result<RecoveryPoint>>
    forgetRecoveryFile(request: { id: string }): Promise<Result<void>>
    historyBackupStatus(): Promise<Result<HistoryBackupStatus>>
    restoreHistoryBackup(request: { token: string }): Promise<Result<HistoryBackupRestoreResult>>
    create(name: string, description?: string | null): Promise<Result<Snapshot>>
    list(): Promise<Result<Snapshot[]>>
    compare(a: string, b: string, scopeNodeId?: string | null): Promise<Result<DiffEntry[]>>
    /** Full compare: returns merged tree with per-node diffs embedded. */
    loadCompare(a: string, b: string, scopeNodeId?: string | null): Promise<Result<MergedTree>>
    revert(request: SnapshotRevertRequest): Promise<Result<SnapshotRevertResult>>
    timeline(): Promise<Result<SnapshotTimeline>>
    applyRecovery(request: RecoveryPointApplyRequest): Promise<Result<RecoveryPointApplyResult>>
  }
  git: {
    check(): Promise<Result<GitStatus>>
  }
  report: {
    /** Build a diff report between two refs (snapshot name or the `@current` sentinel) and write it via a save dialog. savedPath is null if canceled. */
    export(from: string, to: string, format: ReportFormat, scopeNodeId?: string | null): Promise<Result<{ savedPath: string | null }>>
    /** Build a diff report between two refs (snapshot name or `@current`) and return its content (for clipboard copy). */
    build(from: string, to: string, format: ReportFormat, scopeNodeId?: string | null): Promise<Result<{ content: string; suggestedName: string }>>
  }
  dialog: {
    openFolder(title: string, purpose?: FolderDialogPurpose): Promise<string | null>
    openFile(title: string): Promise<string | null>
  }
  menu: {
    onCommand(handler: (command: MenuCommandId) => void): () => void
    updateState(state: MenuCommandState): void
  }
  windowState: {
    isFocused(): Promise<Result<boolean>>
    onFocusChanged(handler: (isFocused: boolean) => void): () => void
  }
  recentProjects: {
    list(): Promise<Result<RecentProject[]>>
  }
  settings: {
    get(): Promise<Result<WorkspaceSettings>>
    updateWorkspace(patch: WorkspaceSettingsPatch): Promise<Result<WorkspaceSettings>>
    getPreferences(): Promise<Result<AppPreferences>>
    updatePreferences(patch: AppPreferencesPatch): Promise<Result<AppPreferences>>
    onPreferencesChanged(handler: (preferences: AppPreferences) => void): () => void
    resetLayout(): Promise<Result<WorkspaceSettings>>
    closeWindow(): Promise<Result<void>>
    onLayoutReset(handler: (settings: WorkspaceSettings) => void): () => void
  }
}
