// Preload script: the only bridge between renderer and main process.
// Exposes a typed, minimal API surface via contextBridge.
// Nothing outside this whitelist is accessible from the renderer.

import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { AppPreferences, StatekeepAPI, WorkspaceSettings } from '../shared/ipc'
import { isMenuCommandId } from '../shared/menu-commands'
import { desktopChromeForPlatform } from '../shared/desktop-chrome'

const api: StatekeepAPI = {
  historyOperation: {
    status: () => ipcRenderer.invoke(IPC.HISTORY_OPERATION_STATUS),
    review: () => ipcRenderer.invoke(IPC.HISTORY_OPERATION_REVIEW),
    acknowledge: request => ipcRenderer.invoke(IPC.HISTORY_OPERATION_ACKNOWLEDGE, request),
    evidencePreview: () => ipcRenderer.invoke(IPC.HISTORY_OPERATION_EVIDENCE_PREVIEW),
    deleteEvidence: request => ipcRenderer.invoke(IPC.HISTORY_OPERATION_EVIDENCE_DELETE, request),
  },
  documentConflict: {
    status: () => ipcRenderer.invoke(IPC.DOCUMENT_SAVE_STATUS),
    review: () => ipcRenderer.invoke(IPC.DOCUMENT_CONFLICT_REVIEW),
    resolve: request => ipcRenderer.invoke(IPC.DOCUMENT_CONFLICT_RESOLVE, request),
  },
  archive: {
    export: () => ipcRenderer.invoke(IPC.ARCHIVE_EXPORT),
    inspect: () => ipcRenderer.invoke(IPC.ARCHIVE_INSPECT),
    restore: request => ipcRenderer.invoke(IPC.ARCHIVE_RESTORE, request),
  },
  platform: desktopChromeForPlatform(process.platform),

  project: {
    create: (name, parentPath) =>
      ipcRenderer.invoke(IPC.PROJECT_CREATE, { name, parentPath }),
    open: (path) =>
      ipcRenderer.invoke(IPC.PROJECT_OPEN, { path }),
    openExample: () =>
      ipcRenderer.invoke(IPC.PROJECT_OPEN_EXAMPLE),
    save: () =>
      ipcRenderer.invoke(IPC.PROJECT_SAVE),
    getCurrent: () =>
      ipcRenderer.invoke(IPC.PROJECT_GET_CURRENT),
    close: () =>
      ipcRenderer.invoke(IPC.PROJECT_CLOSE),
    undo: () => ipcRenderer.invoke(IPC.PROJECT_UNDO),
    redo: () => ipcRenderer.invoke(IPC.PROJECT_REDO),
    editHistory: () => ipcRenderer.invoke(IPC.PROJECT_EDIT_HISTORY),
    onOpenedFromOs: (handler) => {
      const listener = (_event: Electron.IpcRendererEvent, result: unknown) => {
        handler(result as Awaited<ReturnType<StatekeepAPI['project']['open']>>)
      }
      ipcRenderer.on(IPC.PROJECT_OPENED_FROM_OS, listener)
      return () => {
        ipcRenderer.removeListener(IPC.PROJECT_OPENED_FROM_OS, listener)
      }
    },
  },

  text: {
    undoRedo: (direction) => ipcRenderer.invoke(IPC.TEXT_UNDO_REDO, direction),
  },

  node: {
    duplicate: (id, name) => ipcRenderer.invoke(IPC.NODE_DUPLICATE, { id, name }),
    batchUpdateProperties: (request) => ipcRenderer.invoke(IPC.NODE_BATCH_UPDATE_PROPERTIES, request),
    create: (parentId, name, templateId) =>
      ipcRenderer.invoke(IPC.NODE_CREATE, { parentId, name, templateId }),
    update: (id, changes) =>
      ipcRenderer.invoke(IPC.NODE_UPDATE, { id, changes }),
    delete: (id, options) =>
      ipcRenderer.invoke(IPC.NODE_DELETE, { id, options }),
    move: (id, newParentId, newOrder) =>
      ipcRenderer.invoke(IPC.NODE_MOVE, { id, newParentId, newOrder }),
    history: (nodeId) =>
      ipcRenderer.invoke(IPC.NODE_HISTORY, { nodeId }),
    historyBackfillStatus: () =>
      ipcRenderer.invoke(IPC.NODE_HISTORY_BACKFILL_STATUS, {}),
    historyReindex: () =>
      ipcRenderer.invoke(IPC.NODE_HISTORY_REINDEX, {}),
  },

  template: {
    create: (id, template) =>
      ipcRenderer.invoke(IPC.TEMPLATE_CREATE, { id, template }),
    update: (id, changes) =>
      ipcRenderer.invoke(IPC.TEMPLATE_UPDATE, { id, changes }),
    delete: (id) =>
      ipcRenderer.invoke(IPC.TEMPLATE_DELETE, { id }),
  },

  import: {
    inspect: (path) =>
      ipcRenderer.invoke(IPC.IMPORT_INSPECT, { path }),
    plan: (path, mapping) =>
      ipcRenderer.invoke(IPC.IMPORT_PLAN, { path, mapping }),
    apply: (path, mapping) =>
      ipcRenderer.invoke(IPC.IMPORT_APPLY, { path, mapping }),
    netboxInspect: (path) =>
      ipcRenderer.invoke(IPC.IMPORT_NETBOX_INSPECT, { path }),
    netboxPlan: (path, options) =>
      ipcRenderer.invoke(IPC.IMPORT_NETBOX_PLAN, { path, options }),
    netboxApply: (path, options) =>
      ipcRenderer.invoke(IPC.IMPORT_NETBOX_APPLY, { path, options }),
  },

  search: {
    query: (query, offset, limit, filters) =>
      ipcRenderer.invoke(IPC.SEARCH_QUERY, { query, offset, limit, filters }),
  },

  inventory: {
    query: (request) =>
      ipcRenderer.invoke(IPC.INVENTORY_TABLE_QUERY, request),
    exportCsv: (request) =>
      ipcRenderer.invoke(IPC.INVENTORY_EXPORT_CSV, request),
  },

  snapshot: {
    recoveryFilesPreview: () => ipcRenderer.invoke(IPC.RECOVERY_FILES_PREVIEW),
    adoptRecoveryFile: request => ipcRenderer.invoke(IPC.RECOVERY_FILES_ADOPT, request),
    forgetRecoveryFile: request => ipcRenderer.invoke(IPC.RECOVERY_FILES_FORGET, request),
    historyBackupStatus: () => ipcRenderer.invoke(IPC.HISTORY_BACKUP_STATUS),
    restoreHistoryBackup: (request) => ipcRenderer.invoke(IPC.HISTORY_BACKUP_RESTORE, request),
    create: (name, description) =>
      ipcRenderer.invoke(IPC.SNAPSHOT_CREATE, { name, description }),
    list: () =>
      ipcRenderer.invoke(IPC.SNAPSHOT_LIST, {}),
    compare: (a, b, scopeNodeId) =>
      ipcRenderer.invoke(IPC.SNAPSHOT_COMPARE, { a, b, scopeNodeId }),
    loadCompare: (a, b, scopeNodeId) =>
      ipcRenderer.invoke(IPC.SNAPSHOT_LOAD_COMPARE, { a, b, scopeNodeId }),
    revert: (request) =>
      ipcRenderer.invoke(IPC.SNAPSHOT_REVERT, request),
    timeline: () =>
      ipcRenderer.invoke(IPC.SNAPSHOT_TIMELINE, {}),
    applyRecovery: (request) =>
      ipcRenderer.invoke(IPC.RECOVERY_APPLY, request),
  },

  git: {
    check: () =>
      ipcRenderer.invoke(IPC.GIT_CHECK, {}),
  },

  report: {
    export: (from, to, format, scopeNodeId) =>
      ipcRenderer.invoke(IPC.REPORT_EXPORT, { from, to, format, scopeNodeId }),
    build: (from, to, format, scopeNodeId) =>
      ipcRenderer.invoke(IPC.REPORT_BUILD, { from, to, format, scopeNodeId }),
  },

  dialog: {
    openFolder: (title, purpose) =>
      ipcRenderer.invoke(IPC.DIALOG_OPEN_FOLDER, { title, purpose }),
    openFile: (title) =>
      ipcRenderer.invoke(IPC.DIALOG_OPEN_FILE, { title }),
  },

  menu: {
    onCommand: (handler) => {
      const listener = (_event: Electron.IpcRendererEvent, command: unknown) => {
        if (isMenuCommandId(command)) handler(command)
      }
      ipcRenderer.on(IPC.MENU_COMMAND, listener)
      return () => {
        ipcRenderer.removeListener(IPC.MENU_COMMAND, listener)
      }
    },
    updateState: (state) =>
      ipcRenderer.send(IPC.MENU_STATE_UPDATE, state),
  },

  windowState: {
    isFocused: () =>
      ipcRenderer.invoke(IPC.WINDOW_FOCUS_GET),
    onFocusChanged: (handler) => {
      const listener = (_event: Electron.IpcRendererEvent, isFocused: unknown) => {
        if (typeof isFocused === 'boolean') handler(isFocused)
      }
      ipcRenderer.on(IPC.WINDOW_FOCUS_CHANGED, listener)
      return () => {
        ipcRenderer.removeListener(IPC.WINDOW_FOCUS_CHANGED, listener)
      }
    },
  },

  recentProjects: {
    list: () =>
      ipcRenderer.invoke(IPC.RECENT_PROJECTS_LIST, {}),
  },

  settings: {
    get: () =>
      ipcRenderer.invoke(IPC.SETTINGS_GET, {}),
    updateWorkspace: (patch) =>
      ipcRenderer.invoke(IPC.SETTINGS_UPDATE_WORKSPACE, patch),
    getPreferences: () =>
      ipcRenderer.invoke(IPC.SETTINGS_GET_PREFERENCES, {}),
    updatePreferences: (patch) =>
      ipcRenderer.invoke(IPC.SETTINGS_UPDATE_PREFERENCES, patch),
    onPreferencesChanged: (handler) => {
      const listener = (_event: Electron.IpcRendererEvent, preferences: unknown) => {
        handler(preferences as AppPreferences)
      }
      ipcRenderer.on(IPC.SETTINGS_PREFERENCES_CHANGED, listener)
      return () => {
        ipcRenderer.removeListener(IPC.SETTINGS_PREFERENCES_CHANGED, listener)
      }
    },
    resetLayout: () =>
      ipcRenderer.invoke(IPC.SETTINGS_RESET_LAYOUT, {}),
    closeWindow: () =>
      ipcRenderer.invoke(IPC.SETTINGS_CLOSE_WINDOW, {}),
    onLayoutReset: (handler) => {
      const listener = (_event: Electron.IpcRendererEvent, settings: unknown) => {
        handler(settings as WorkspaceSettings)
      }
      ipcRenderer.on(IPC.SETTINGS_LAYOUT_RESET, listener)
      return () => {
        ipcRenderer.removeListener(IPC.SETTINGS_LAYOUT_RESET, listener)
      }
    },
  },
}

contextBridge.exposeInMainWorld('api', api)
