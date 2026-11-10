import { app, BrowserWindow, ipcMain, dialog, shell, screen, clipboard, nativeTheme } from 'electron'
import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { createLogger } from './logger'
import { ProjectManager } from './project-manager'
import { GitService } from './git-service'
import { IPC, type FolderDialogPurpose } from '../shared/ipc'
import { ok, err, ErrorCode } from '../shared/errors'
import {
  installApplicationMenu,
  updateApplicationMenuRecentProjects,
  updateApplicationMenuState,
} from './app-menu'
import { resolveProjectOpenTarget } from './project-open-target'
import { collectProjectOpenTargets, isDefaultAppPathTarget, type LaunchArgumentEnvironment } from './launch-arguments'
import { openExampleProject } from './example-project'
import { createStarterProject } from './project-starters'
import { secureIpcMain, denySessionPermissions, denyWebviews } from './security'
import { isTrustedRendererNavigationUrl } from './renderer-navigation'
import { RecentProjectsStore, getRecentDocumentPath } from './recent-projects'
import {
  AppSettingsStore,
  resolveRestorableWindowBounds,
  type AppPreferencesPatch,
  type WorkspaceSettings,
  type WorkspaceSettingsPatch,
} from './app-settings'
import { desktopChromeForPlatform } from '../shared/desktop-chrome'
import { isAppearanceMode, resolveTheme } from '../shared/theme'
import { buildDiagnostics } from './diagnostics'
import { buildDiagnosticsBundle } from './diagnostics-export'
import { installRendererRecovery } from './renderer-recovery'
import {
  ensureFinalProjectSave,
  finalSaveFailureActionForResponse,
  finalSaveFailureDialogOptions,
  type FinalSaveContext,
  type FinalSaveFailureAction,
} from './final-save'
import type { Project, Result, NodeTemplate, ImportMapping, NetboxImportOptions } from '../shared/types'
import type { BatchPropertyUpdateRequest } from '../shared/batch-properties'
import { isReportFormat } from '../shared/report'
import { isE2eBackground } from './e2e-background'
import { DOCUMENTATION_URL, REPORT_ISSUE_URL, RELEASES_URL, WEBSITE_URL } from '../shared/external-links'
import { closeHelpWindow, installHelpProtocol, openHelpWindow, registerHelpScheme } from './help-window'
import { helpRootFor, readOfflineHelpInfo } from './offline-help'

// ─── Logging ────────────────────────────────────────────────────────────────

const userData = app.getPath('userData')
const logDir   = join(userData, 'logs')

const appLogger     = createLogger('app',     join(logDir, 'app.log'))
const gitLogger     = createLogger('git',     join(logDir, 'git.log'))
const projectLogger = createLogger('project', join(logDir, 'project.log'))

// ─── Services ────────────────────────────────────────────────────────────────

const gitService     = new GitService(gitLogger)
const projectManager = new ProjectManager(gitService, projectLogger)
const recentProjects = new RecentProjectsStore(join(userData, 'recent-projects.json'))
const appSettings = new AppSettingsStore(join(userData, 'app-settings.json'))
const SETTINGS_WINDOW_WIDTH = 760
const SETTINGS_WINDOW_HEIGHT = 560
const e2eBackground = isE2eBackground(process.env)

registerHelpScheme()
// Install before any BrowserWindow or partition is created, including Help.
app.on('session-created', denySessionPermissions)
app.on('web-contents-created', (_event, contents) => denyWebviews(contents))

// ─── Window ──────────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null
let rendererRecovery: ReturnType<typeof installRendererRecovery> | null = null
app.on('child-process-gone', (_event, details) => {
  if (rendererRecovery) rendererRecovery.childProcessGone(details)
  else appLogger.error('child process gone', { type: details.type, reason: details.reason, exitCode: details.exitCode })
})
let settingsWindow: BrowserWindow | null = null
const pendingOpenTargets: string[] = []
let ownsSingleInstanceLock = false
let quitAfterFinalSave = false
let finalQuitInProgress = false
const approvedWindowCloses = new WeakSet<BrowserWindow>()
let windowStateSaveTimer: ReturnType<typeof setTimeout> | null = null
// Until startup creates the project window, it loads whatever project is open
// by then; afterwards a missing project window means only Help is left open.
let startupWindowCreated = false

function createWindow(): BrowserWindow {
  const iconPath = getBrandIconPath()
  const storedWindowState = appSettings.getWindowState()
  const restoredBounds = resolveRestorableWindowBounds(storedWindowState, screen.getAllDisplays())
  const desktopChrome = desktopChromeForPlatform(process.platform)
  const win = new BrowserWindow({
    x: restoredBounds?.x,
    y: restoredBounds?.y,
    width: restoredBounds?.width ?? 1280,
    height: restoredBounds?.height ?? 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Statekeep',
    icon: iconPath,
    backgroundColor: windowBackgroundColor(),
    titleBarStyle: desktopChrome.titleBarStyle,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Hidden E2E windows need timers; these runs do not cover production timer throttling.
      backgroundThrottling: !e2eBackground,
    },
  })

  if (!e2eBackground && storedWindowState?.isMaximized) {
    win.maximize()
  }
  if (!e2eBackground && storedWindowState?.isFullScreen) {
    win.setFullScreen(true)
  }

  if (!e2eBackground) win.once('ready-to-show', () => win.show())
  configureRendererNavigation(win)
  rendererRecovery = installRendererRecovery({
    window: win, logger: appLogger,
    hasProject: () => projectManager.getCurrent() !== null,
    saveProject: () => projectManager.saveProject(),
    showDialog: (options) => dialog.showMessageBox(win, options),
  })
  win.on('focus', () => { projectManager.checkExternalDocument(); notifyWindowFocusChanged(win, true) })
  win.on('blur', () => notifyWindowFocusChanged(win, false))
  win.webContents.on('did-finish-load', () => notifyWindowFocusChanged(win, win.isFocused()))
  win.on('move', () => scheduleWindowStateSave(win))
  win.on('resize', () => scheduleWindowStateSave(win))
  win.on('maximize', () => saveWindowState(win))
  win.on('unmaximize', () => saveWindowState(win))
  win.on('enter-full-screen', () => saveWindowState(win))
  win.on('leave-full-screen', () => saveWindowState(win))
  win.on('close', (event) => {
    saveWindowState(win)
    if (quitAfterFinalSave || approvedWindowCloses.has(win) || !projectManager.getCurrent()) return
    event.preventDefault()
    void closeWindowAfterFinalSave(win)
  })
  win.on('closed', () => {
    if (mainWindow === win) { mainWindow = null; rendererRecovery = null }
    // Elsewhere the app quits with its last window, so Help must not keep it
    // running once the project window is gone.
    if (process.platform !== 'darwin') closeHelpWindow()
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow = win
  return win
}

function createSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (!e2eBackground) {
      if (settingsWindow.isMinimized()) settingsWindow.restore()
      settingsWindow.show()
      settingsWindow.focus()
    }
    return settingsWindow
  }

  const desktopChrome = desktopChromeForPlatform(process.platform)
  const owner = mainWindow ?? BrowserWindow.getFocusedWindow()
  const position = settingsWindowPosition(owner, SETTINGS_WINDOW_WIDTH, SETTINGS_WINDOW_HEIGHT)
  const win = new BrowserWindow({
    ...position,
    width: SETTINGS_WINDOW_WIDTH,
    height: SETTINGS_WINDOW_HEIGHT,
    minWidth: 640,
    minHeight: 480,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Statekeep Settings',
    icon: getBrandIconPath(),
    backgroundColor: windowBackgroundColor(),
    titleBarStyle: desktopChrome.titleBarStyle,
    parent: owner ?? undefined,
    modal: owner !== null,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !e2eBackground,
    },
  })

  if (!e2eBackground) win.once('ready-to-show', () => win.show())
  configureRendererNavigation(win)
  win.on('focus', () => notifyWindowFocusChanged(win, true))
  win.on('blur', () => notifyWindowFocusChanged(win, false))
  win.webContents.on('did-finish-load', () => notifyWindowFocusChanged(win, win.isFocused()))
  win.on('closed', () => {
    if (settingsWindow === win) settingsWindow = null
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    const settingsUrl = new URL(process.env['ELECTRON_RENDERER_URL'])
    settingsUrl.searchParams.set('settings', '1')
    void win.loadURL(settingsUrl.toString())
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { settings: '1' } })
  }

  settingsWindow = win
  return win
}

function settingsWindowPosition(
  owner: BrowserWindow | null,
  width: number,
  height: number,
): { x: number; y: number } | undefined {
  if (!owner || owner.isDestroyed()) return undefined
  const ownerBounds = owner.getBounds()
  const workArea = screen.getDisplayMatching(ownerBounds).workArea
  const gap = 24
  const rightEdge = workArea.x + workArea.width
  const bottomEdge = workArea.y + workArea.height
  const fitsRight = ownerBounds.x + ownerBounds.width + gap + width <= rightEdge
  const fitsLeft = ownerBounds.x - gap - width >= workArea.x
  const preferredX = fitsRight
    ? ownerBounds.x + ownerBounds.width + gap
    : fitsLeft
      ? ownerBounds.x - gap - width
      : ownerBounds.x + Math.round((ownerBounds.width - width) / 2)
  const preferredY = ownerBounds.y + Math.round((ownerBounds.height - height) / 2)

  return {
    x: clampWindowCoordinate(preferredX, workArea.x, rightEdge - width),
    y: clampWindowCoordinate(preferredY, workArea.y, bottomEdge - height),
  }
}

function clampWindowCoordinate(value: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(value, Math.max(min, max))))
}

function synchronizeNativeAppearance(): void {
  nativeTheme.themeSource = appSettings.getPreferences().appearance.mode
  updateWindowThemeBackgrounds()
}

function windowBackgroundColor(): string {
  const preference = appSettings.getPreferences().appearance
  const theme = resolveTheme(preference, nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  return theme.tokens['surface-canvas']
}

function updateWindowThemeBackgrounds(): void {
  const backgroundColor = windowBackgroundColor()
  for (const win of [mainWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) win.setBackgroundColor(backgroundColor)
  }
}

function broadcastPreferencesChanged(): void {
  const preferences = appSettings.getPreferences()
  for (const win of [mainWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.SETTINGS_PREFERENCES_CHANGED, preferences)
    }
  }
}

nativeTheme.on('updated', () => {
  updateWindowThemeBackgrounds()
  broadcastPreferencesChanged()
})

// ─── IPC handlers ────────────────────────────────────────────────────────────

function registerIpcHandlers(): void {
  const trustedIpc = secureIpcMain(ipcMain, {
    rendererFile: join(__dirname, '../renderer/index.html'),
    devServerUrl: app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'],
    roleFor: sender => {
      if (mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents) return 'project'
      if (settingsWindow && !settingsWindow.isDestroyed() && sender === settingsWindow.webContents) return 'settings'
      return null
    },
  })
  trustedIpc.handle(IPC.HISTORY_OPERATION_STATUS, () => projectManager.interruptedHistoryStatus())
  trustedIpc.handle(IPC.HISTORY_OPERATION_REVIEW, () => projectManager.reviewInterruptedHistory())
  trustedIpc.handle(IPC.HISTORY_OPERATION_ACKNOWLEDGE, (_, request: unknown) => projectManager.acknowledgeInterruptedHistory(request))
  trustedIpc.handle(IPC.HISTORY_OPERATION_EVIDENCE_PREVIEW, () => projectManager.interruptedHistoryEvidencePreview())
  trustedIpc.handle(IPC.HISTORY_OPERATION_EVIDENCE_DELETE, (_, request: unknown) => projectManager.deleteInterruptedHistoryEvidence(request))
  trustedIpc.handle(IPC.DOCUMENT_SAVE_STATUS, () => projectManager.documentSaveStatus())
  trustedIpc.handle(IPC.DOCUMENT_CONFLICT_REVIEW, () => projectManager.reviewExternalDocument())
  trustedIpc.handle(IPC.DOCUMENT_CONFLICT_RESOLVE, (_, request: unknown) => projectManager.resolveExternalDocument(request))

  trustedIpc.handle(IPC.ARCHIVE_EXPORT, async () => {
    try {
      const project = projectManager.getCurrent()
      if (!project) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
      const selected = await dialog.showSaveDialog({ title: 'Export project archive',
        defaultPath: join(app.getPath('documents'), 'Statekeep.statekeeparchive'),
        filters: [{ name: 'Statekeep project archive', extensions: ['statekeeparchive'] }] })
      if (selected.canceled || !selected.filePath) return ok(null)
      if (projectManager.getCurrent()?.path !== project.path) return err(ErrorCode.VALIDATION_FAILED, 'Project changed. Export again.')
      return projectManager.exportProjectArchive(selected.filePath)
    } catch (error) { return err(ErrorCode.ARCHIVE_FAILED, String(error)) }
  })
  trustedIpc.handle(IPC.ARCHIVE_INSPECT, async () => {
    try {
      const selected = await dialog.showOpenDialog({ title: 'Review project archive', properties: ['openFile'],
        filters: [{ name: 'Statekeep project archive', extensions: ['statekeeparchive'] }] })
      if (selected.canceled || !selected.filePaths[0]) return ok(null)
      return projectManager.inspectProjectArchive(selected.filePaths[0])
    } catch (error) { return err(ErrorCode.ARCHIVE_FAILED, String(error)) }
  })
  trustedIpc.handle(IPC.ARCHIVE_RESTORE, async (_, request: { token?: unknown } | null) => {
    try {
      if (typeof request?.token !== 'string') return err(ErrorCode.VALIDATION_FAILED, 'Review an archive first.')
      const selected = await dialog.showOpenDialog({ title: 'Choose parent folder for a new restored project', properties: ['openDirectory', 'createDirectory'] })
      if (selected.canceled || !selected.filePaths[0]) return ok(null)
      return projectManager.restoreProjectArchive(request.token, selected.filePaths[0])
    } catch (error) { return err(ErrorCode.ARCHIVE_FAILED, String(error)) }
  })

  // ── Project lifecycle ────────────────────────────────────────────────────

  trustedIpc.handle(IPC.PROJECT_CREATE, async (_, { name, parentPath }: { name: string; parentPath: string }) => {
    const result = await projectManager.createProject(name, parentPath)
    trackRecentProject(result)
    return result
  })

  trustedIpc.handle(IPC.PROJECT_OPEN, async (_, { path }: { path: string }) => {
    const resolved = resolveProjectOpenTarget(path)
    if (!resolved.ok) return resolved
    const result = await projectManager.openProject(resolved.data)
    trackRecentProject(result)
    return result
  })

  trustedIpc.handle(IPC.PROJECT_CREATE_STARTER, async (_, request: unknown) => {
    const result = await createStarterProject(projectManager, request)
    trackRecentProject(result)
    return result
  })

  trustedIpc.handle(IPC.PROJECT_OPEN_EXAMPLE, async () => {
    const configuredDirectory = process.env['STATEKEEP_EXAMPLE_PROJECTS_DIR']?.trim()
    // The example is a user-owned project, so keep it visible alongside their documents.
    const examplesDirectory = configuredDirectory || join(app.getPath('documents'), 'Statekeep Examples')
    const result = await openExampleProject(projectManager, examplesDirectory)
    trackRecentProject(result)
    return result
  })

  trustedIpc.handle(IPC.PROJECT_SAVE, async () =>
    projectManager.saveProject()
  )

  trustedIpc.handle(IPC.PROJECT_UNDO, () => projectManager.undo())
  trustedIpc.handle(IPC.PROJECT_REDO, () => projectManager.redo())
  trustedIpc.handle(IPC.PROJECT_EDIT_HISTORY, () => ok(projectManager.editHistoryState()))
  trustedIpc.handle(IPC.TEXT_UNDO_REDO, (event, direction: unknown) => {
    if (direction !== 'undo' && direction !== 'redo') {
      return err(ErrorCode.VALIDATION_FAILED, 'Invalid text editing command')
    }
    event.sender[direction]()
    return ok(undefined)
  })

  trustedIpc.handle(IPC.PROJECT_GET_CURRENT, () => {
    const project = projectManager.getCurrent()
    return ok(project)
  })

  trustedIpc.handle(IPC.PROJECT_CLOSE, async () =>
    closeProjectAfterFinalSave(mainWindow ?? BrowserWindow.getFocusedWindow())
  )

  // ── Node CRUD ────────────────────────────────────────────────────────────

  trustedIpc.handle(IPC.NODE_DUPLICATE, (_, { id, name }: { id: string; name: string }) =>
    projectManager.nodeDuplicate(id, name)
  )

  trustedIpc.handle(IPC.NODE_BATCH_UPDATE_PROPERTIES, (_, request: BatchPropertyUpdateRequest) =>
    projectManager.nodeBatchUpdateProperties(request)
  )

  trustedIpc.handle(IPC.NODE_CREATE, (
    _,
    { parentId, name, templateId }: { parentId: string; name: string; templateId?: string | null }
  ) => projectManager.nodeCreate(parentId, name, templateId))

  trustedIpc.handle(IPC.NODE_UPDATE, (
    _,
    { id, changes }: {
      id: string
      changes: {
        name?: string
        properties?: Record<string, string | number | boolean | null>
        templateId?: string | null
      }
    }
  ) => projectManager.nodeUpdate(id, changes))

  trustedIpc.handle(IPC.NODE_DELETE, (
    _,
    { id, options }: { id: string; options?: { unlinkReferences?: boolean } }
  ) => projectManager.nodeDelete(id, options))

  trustedIpc.handle(IPC.NODE_MOVE, (
    _,
    { id, newParentId, newOrder }: { id: string; newParentId: string; newOrder: number }
  ) => projectManager.nodeMove(id, newParentId, newOrder))

  trustedIpc.handle(IPC.NODE_HISTORY, (_, { nodeId }: { nodeId: string }) =>
    projectManager.nodeHistory(nodeId)
  )

  trustedIpc.handle(IPC.NODE_HISTORY_BACKFILL_STATUS, () =>
    ok(projectManager.getHistoryIndexStatus())
  )

  trustedIpc.handle(IPC.NODE_HISTORY_REINDEX, () =>
    projectManager.reindexHistory()
  )

  // ── Templates ──────────────────────────────────────────────────────────────

  trustedIpc.handle(IPC.TEMPLATE_CREATE, (
    _,
    { id, template }: { id: string; template: NodeTemplate }
  ) => projectManager.templateCreate(id, template))

  trustedIpc.handle(IPC.TEMPLATE_UPDATE, (
    _,
    { id, changes }: { id: string; changes: Partial<NodeTemplate> }
  ) => projectManager.templateUpdate(id, changes))

  trustedIpc.handle(IPC.TEMPLATE_DELETE, (_, { id }: { id: string }) =>
    projectManager.templateDelete(id)
  )

  // ── CSV import ─────────────────────────────────────────────────────────────

  trustedIpc.handle(IPC.IMPORT_INSPECT, (_, { path }: { path: string }) =>
    projectManager.inspectImport(path)
  )

  trustedIpc.handle(IPC.IMPORT_PLAN, (_, { path, mapping }: { path: string; mapping: ImportMapping }) =>
    projectManager.planImportCsv(path, mapping)
  )

  trustedIpc.handle(IPC.IMPORT_APPLY, (_, { path, mapping }: { path: string; mapping: ImportMapping }) =>
    projectManager.applyImportCsv(path, mapping)
  )

  // ── NetBox import ──────────────────────────────────────────────────────────

  trustedIpc.handle(IPC.IMPORT_NETBOX_INSPECT, (_, { path }: { path: string }) =>
    projectManager.inspectNetboxImport(path)
  )

  trustedIpc.handle(
    IPC.IMPORT_NETBOX_PLAN,
    (_, { path, options }: { path: string; options: NetboxImportOptions }) =>
      projectManager.planNetboxImport(path, options)
  )

  trustedIpc.handle(IPC.INVENTORY_TABLE_QUERY, (_, request: unknown) =>
    projectManager.inventoryTable(request)
  )

  trustedIpc.handle(IPC.INVENTORY_EXPORT_CSV, async (_, request: unknown) => {
    const prepared = projectManager.prepareInventoryCsv(request)
    if (!prepared.ok) return prepared
    try {
      const result = await dialog.showSaveDialog({
        title: 'Export inventory',
        defaultPath: prepared.data.suggestedName,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      })
      if (result.canceled || !result.filePath) return ok({ savedPath: null, rowCount: 0 })
      const built = projectManager.buildInventoryCsv(request)
      if (!built.ok) return built
      await writeFile(result.filePath, built.data.content, 'utf8')
      return ok({ savedPath: result.filePath, rowCount: built.data.rowCount })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return err(ErrorCode.REPORT_WRITE_FAILED, `Failed to write inventory export: ${msg}`)
    }
  })

  trustedIpc.handle(
    IPC.IMPORT_NETBOX_APPLY,
    (_, { path, options }: { path: string; options: NetboxImportOptions }) =>
      projectManager.applyNetboxImport(path, options)
  )

  // ── Search ───────────────────────────────────────────────────────────────

  trustedIpc.handle(
    IPC.SEARCH_QUERY,
    (_, { query, offset, limit, filters }: {
      query: string
      offset?: number
      limit?: number
      filters?: unknown
    }) => projectManager.searchNodesPage(query, offset, limit, filters)
  )

  // ── Git ──────────────────────────────────────────────────────────────────

  trustedIpc.handle(IPC.GIT_CHECK, async () => {
    const status = await gitService.checkVersion()
    return ok(status)
  })

  // ── Report export ──────────────────────────────────────────────────────────
  // Main builds the content authoritatively (ProjectManager.buildReport) and owns
  // the save dialog + file write — the renderer never touches the filesystem.

  trustedIpc.handle(IPC.REPORT_EXPORT, async (_, { from, to, format, scopeNodeId }: { from: string; to: string; format: unknown; scopeNodeId?: unknown }) => {
    if (!isReportFormat(format)) {
      return err(ErrorCode.VALIDATION_FAILED, 'Report format must be markdown, csv, or html')
    }
    const built = await projectManager.buildReport(from, to, format, scopeNodeId)
    if (!built.ok) return built
    // showSaveDialog AND writeFile are both inside the try so a dialog or write
    // rejection resolves to a Result, never throwing across the IPC boundary.
    try {
      const result = await dialog.showSaveDialog({
        title: 'Export change report',
        defaultPath: built.data.suggestedName,
        filters: [format === 'csv'
          ? { name: 'CSV', extensions: ['csv'] }
          : format === 'html'
            ? { name: 'HTML', extensions: ['html'] }
            : { name: 'Markdown', extensions: ['md'] }],
      })
      if (result.canceled || !result.filePath) return ok({ savedPath: null })
      await writeFile(result.filePath, built.data.content, 'utf8')
      return ok({ savedPath: result.filePath })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return err(ErrorCode.REPORT_WRITE_FAILED, `Failed to write report: ${msg}`)
    }
  })

  trustedIpc.handle(IPC.REPORT_BUILD, (_, { from, to, format, scopeNodeId }: { from: string; to: string; format: unknown; scopeNodeId?: unknown }) =>
    projectManager.buildReport(from, to, format, scopeNodeId)
  )

  // ── Dialog helpers ───────────────────────────────────────────────────────

  trustedIpc.handle(IPC.DIALOG_OPEN_FOLDER, async (_, { title, purpose }: { title: string; purpose?: FolderDialogPurpose }) => {
    const directoryKind = directoryKindForFolderDialogPurpose(purpose)
    const result = await dialog.showOpenDialog({
      title,
      defaultPath: directoryKind ? appSettings.getLastDirectory(directoryKind) : undefined,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (!result.canceled && result.filePaths[0] && directoryKind) {
      appSettings.recordLastDirectory(directoryKind, result.filePaths[0])
    }
    return result.canceled ? null : result.filePaths[0]
  })

  trustedIpc.handle(IPC.DIALOG_OPEN_FILE, async (_, { title }: { title: string }) => {
    const result = await dialog.showOpenDialog({
      title,
      properties: ['openFile'],
      filters: [
        { name: 'Importable (CSV, NetBox JSON)', extensions: ['csv', 'json'] },
        { name: 'CSV', extensions: ['csv'] },
        { name: 'NetBox JSON', extensions: ['json'] },
      ],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // ── Native menu state ────────────────────────────────────────────────────
  // Renderer-owned UI state drives native menu enablement. The renderer still
  // self-guards every command when a menu item or accelerator dispatches.
  trustedIpc.on(IPC.MENU_STATE_UPDATE, (_, state: unknown) => {
    updateApplicationMenuState(state)
  })

  trustedIpc.handle(IPC.WINDOW_FOCUS_GET, (event) =>
    ok(BrowserWindow.fromWebContents(event.sender)?.isFocused() ?? true)
  )

  trustedIpc.handle(IPC.RECENT_PROJECTS_LIST, () =>
    ok(recentProjects.all())
  )

  trustedIpc.handle(IPC.SETTINGS_GET, () =>
    ok(appSettings.getWorkspaceSettings())
  )

  trustedIpc.handle(IPC.SETTINGS_UPDATE_WORKSPACE, (_, patch: unknown) =>
    ok(appSettings.updateWorkspaceSettings(normalizeWorkspaceSettingsPatch(patch)))
  )

  trustedIpc.handle(IPC.SETTINGS_GET_PREFERENCES, () =>
    ok(appSettings.getPreferences())
  )

  trustedIpc.handle(IPC.SETTINGS_UPDATE_PREFERENCES, (_, patch: unknown) => {
    const preferences = appSettings.updatePreferences(normalizePreferencesPatch(patch))
    synchronizeNativeAppearance()
    broadcastPreferencesChanged()
    return ok(preferences)
  })

  trustedIpc.handle(IPC.SETTINGS_RESET_LAYOUT, () => {
    const settings = appSettings.resetLayout()
    resetMainWindowLayout(settings)
    return ok(settings)
  })

  trustedIpc.handle(IPC.SETTINGS_CLOSE_WINDOW, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && win === settingsWindow && !win.isDestroyed()) win.close()
    return ok(undefined)
  })

  // ── Snapshots ────────────────────────────────────────────────────────────

  trustedIpc.handle(IPC.SNAPSHOT_CREATE, (_, { name, description }: { name: unknown; description?: unknown }) =>
    projectManager.snapshotCreate(name, description)
  )

  trustedIpc.handle(IPC.SNAPSHOT_LIST, () =>
    projectManager.snapshotList()
  )

  trustedIpc.handle(IPC.SNAPSHOT_COMPARE, (_, { a, b, scopeNodeId }: { a: string; b: string; scopeNodeId?: unknown }) =>
    projectManager.snapshotCompare(a, b, scopeNodeId)
  )

  trustedIpc.handle(IPC.SNAPSHOT_LOAD_COMPARE, (_, { a, b, scopeNodeId }: { a: string; b: string; scopeNodeId?: unknown }) =>
    projectManager.snapshotLoadCompare(a, b, scopeNodeId)
  )

  trustedIpc.handle(IPC.SNAPSHOT_REVERT, (_, request: { name: string; note?: string | null }) =>
    projectManager.snapshotRevert(request)
  )

  trustedIpc.handle(IPC.SNAPSHOT_TIMELINE, () =>
    projectManager.snapshotTimeline()
  )

  trustedIpc.handle(IPC.HISTORY_BACKUP_STATUS, () => projectManager.historyBackupStatus())
  trustedIpc.handle(IPC.RECOVERY_FILES_PREVIEW, () => projectManager.recoveryFilesPreview())
  trustedIpc.handle(IPC.RECOVERY_FILES_ADOPT, (_, request: unknown) => projectManager.adoptRecoveryFile(request))
  trustedIpc.handle(IPC.RECOVERY_FILES_FORGET, (_, request: unknown) => projectManager.forgetRecoveryFile(request))
  trustedIpc.handle(IPC.HISTORY_BACKUP_RESTORE, (_, request: unknown) => projectManager.restoreHistoryBackup(request))

  trustedIpc.handle(IPC.RECOVERY_APPLY, (_, request: { id: string }) =>
    projectManager.recoveryPointApply(request)
  )
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  if (e2eBackground && process.platform === 'darwin') {
    app.setActivationPolicy('accessory')
    app.dock?.hide()
  }
  appLogger.info('app starting', { version: app.getVersion(), platform: process.platform })
  synchronizeNativeAppearance()

  const gitStatus = await gitService.checkVersion()
  appLogger.info('git version check', { version: gitStatus.version, meetsMinimum: gitStatus.meetsMinimum })

  if (!gitStatus.available) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Git Not Found',
      message: 'Statekeep requires Git to manage project history.',
      detail: getGitInstallInstructions(),
      buttons: ['OK'],
    })
    appLogger.warn('git not available — project creation disabled')
  } else if (!gitStatus.meetsMinimum) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Git Version Too Old',
      message: `Statekeep requires Git ${gitStatus.minimumVersion}+`,
      detail: `Found Git ${gitStatus.version}. Some features may not work correctly. Please update Git.`,
      buttons: ['Continue Anyway', 'Quit'],
      defaultId: 0,
    })
    if (response === 1) {
      app.quit()
      return
    }
  }

  registerIpcHandlers()
  installHelpProtocol(helpRootFor(__dirname), appLogger)
  installApplicationMenu({
    platform: process.platform,
    isDev: Boolean(process.env['ELECTRON_RENDERER_URL']),
    appName: app.name || 'Statekeep',
    logsPath: logDir,
    logger: appLogger,
    recentProjects: recentProjects.all(),
    openRecentProject: openRecentProject,
    clearRecentProjects: clearRecentProjects,
    openPreferences: openPreferences,
    openHelp: openHelp,
    openOnlineDocumentation: openOnlineDocumentation,
    openReleasesPage: openReleasesPage,
    reportIssue: reportIssue,
    copyDiagnostics: copyDiagnostics,
    exportDiagnostics: () => { void exportDiagnostics() },
    showProjectWindow: focusMainWindow,
  })
  const iconPath = getBrandIconPath()
  configureAboutPanel(iconPath)
  if (process.platform === 'darwin' && iconPath) {
    app.dock?.setIcon(iconPath)
  }
  await drainPendingOpenTargets()
  await reopenLastProjectIfRequested()
  createWindow()
  startupWindowCreated = true

  app.on('activate', () => {
    // Help can stay open after the project window closes on macOS.
    if (!mainWindow) createWindow()
  })
})

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  ownsSingleInstanceLock = true
  app.on('second-instance', (_event, argv) => {
    focusMainWindow()
    for (const target of collectOpenTargetsFromArgv(argv)) {
      void openProjectFromOsTarget(target, { notifyRenderer: true })
    }
  })
}

app.on('open-file', (event, path) => {
  event.preventDefault()
  if (isDefaultAppPathTarget(path, launchEnvironment())) return
  queueOpenTarget(path)
})

// Flush autosave before quitting so no changes are lost. Electron cannot await
// before-quit listeners, so normal quits are paused and resumed after the final
// save either succeeds or the user explicitly chooses Quit Anyway.
app.on('before-quit', (event) => {
  if (quitAfterFinalSave || !projectManager.getCurrent()) return
  event.preventDefault()
  void quitAfterFinalSavePrompt()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

for (const target of collectOpenTargetsFromArgv(process.argv)) {
  queueOpenTarget(target)
}

function getGitInstallInstructions(): string {
  switch (process.platform) {
    case 'darwin':
      return 'Install via Xcode Command Line Tools:\n  xcode-select --install\n\nOr download from https://git-scm.com'
    case 'win32':
      return 'Download and install from https://git-scm.com/download/win'
    default:
      return 'Install via your package manager:\n  sudo apt install git\n  sudo dnf install git\n\nOr visit https://git-scm.com'
  }
}

function getBrandIconPath(): string | undefined {
  const iconPath = join(app.getAppPath(), 'resources', 'icon.png')
  return existsSync(iconPath) ? iconPath : undefined
}

function configureAboutPanel(iconPath: string | undefined): void {
  app.setAboutPanelOptions({
    applicationName: app.name || 'Statekeep',
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    copyright: `Copyright © ${new Date().getFullYear()} Statekeep contributors`,
    website: WEBSITE_URL,
    iconPath,
  })
}

function scheduleWindowStateSave(win: BrowserWindow): void {
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer)
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null
    saveWindowState(win)
  }, 250)
}

function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const bounds = (win.isMaximized() || win.isFullScreen())
    ? win.getNormalBounds()
    : win.getBounds()
  appSettings.updateWindowState({
    bounds,
    isMaximized: win.isMaximized(),
    isFullScreen: win.isFullScreen(),
  })
}

async function closeProjectAfterFinalSave(owner: BrowserWindow | null): Promise<Result<void>> {
  const outcome = await runFinalSaveFlow('project-close', owner)
  if (outcome === 'proceed-anyway') {
    projectLogger.warn('project closed after final save failure')
  }
  projectManager.discardCurrentProject()
  return ok(undefined)
}

async function closeWindowAfterFinalSave(win: BrowserWindow): Promise<void> {
  const outcome = await runFinalSaveFlow('window-close', win)
  if (outcome === 'proceed-anyway') {
    projectLogger.warn('window closed after final save failure')
  }
  projectManager.discardCurrentProject()
  if (win.isDestroyed()) return
  approvedWindowCloses.add(win)
  win.close()
}

async function quitAfterFinalSavePrompt(): Promise<void> {
  if (finalQuitInProgress) return
  finalQuitInProgress = true
  const outcome = await runFinalSaveFlow('quit', mainWindow ?? BrowserWindow.getFocusedWindow())
  if (outcome === 'proceed-anyway') {
    projectLogger.warn('app quit after final save failure')
  }
  quitAfterFinalSave = true
  finalQuitInProgress = false
  app.quit()
}

async function runFinalSaveFlow(
  context: FinalSaveContext,
  owner: BrowserWindow | null,
) {
  return ensureFinalProjectSave({
    context,
    window: owner,
    hasOpenProject: () => projectManager.getCurrent() !== null,
    saveProject: async () => {
      projectManager.cancelAutosave()
      return projectManager.saveProject()
    },
    showFailurePrompt: (prompt) => showFinalSaveFailurePrompt(prompt.context, prompt.message, prompt.window ?? null),
    openLogsFolder: async () => {
      await shell.openPath(logDir)
    },
  })
}

async function showFinalSaveFailurePrompt(
  context: FinalSaveContext,
  message: string,
  owner: BrowserWindow | null,
): Promise<FinalSaveFailureAction> {
  const options = finalSaveFailureDialogOptions(context, message)
  const result = owner && !owner.isDestroyed()
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options)
  return finalSaveFailureActionForResponse(result.response)
}

function queueOpenTarget(targetPath: string): void {
  if (!ownsSingleInstanceLock) return
  if (app.isReady()) {
    void openProjectFromOsTarget(targetPath, { notifyRenderer: true })
    return
  }
  pendingOpenTargets.push(targetPath)
}

async function drainPendingOpenTargets(): Promise<void> {
  while (pendingOpenTargets.length > 0) {
    const target = pendingOpenTargets.shift()
    if (!target) continue
    const result = await openProjectFromOsTarget(target, { notifyRenderer: false })
    if (!result.ok) {
      await dialog.showMessageBox({
        type: 'error',
        title: 'Could Not Open Project',
        message: result.error.message,
        buttons: ['OK'],
      })
    }
  }
}

async function reopenLastProjectIfRequested(): Promise<void> {
  if (projectManager.getCurrent() || appSettings.getPreferences().launchBehavior !== 'reopen-last-project') return
  const lastProject = appSettings.getWorkspaceSettings().lastProject
  if (!lastProject?.exists) return

  const result = await openProjectFromOsTarget(lastProject.path, { notifyRenderer: false })
  if (!result.ok) {
    appLogger.warn('could not reopen last project', { path: lastProject.path, error: result.error.message })
  }
}

async function openProjectFromOsTarget(
  targetPath: string,
  options: { notifyRenderer: boolean }
): Promise<Result<Project>> {
  const resolved = resolveProjectOpenTarget(targetPath)
  if (!resolved.ok) {
    notifyProjectOpenFromOs(resolved, options)
    return resolved
  }

  if (projectManager.getCurrent()) {
    const saved = await projectManager.saveProject()
    if (!saved.ok) {
      const failure: Result<Project> = { ok: false, error: saved.error }
      notifyProjectOpenFromOs(failure, options)
      return failure
    }
  }

  const opened = await projectManager.openProject(resolved.data)
  trackRecentProject(opened)
  notifyProjectOpenFromOs(opened, options)
  return opened
}

function openRecentProject(projectPath: string): void {
  void openProjectFromOsTarget(projectPath, { notifyRenderer: true })
}

function clearRecentProjects(): void {
  recentProjects.clear()
  app.clearRecentDocuments()
  updateApplicationMenuRecentProjects(recentProjects.all())
}

function openPreferences(): void {
  createSettingsWindow()
}

function openHelp(): void {
  const root = helpRootFor(__dirname)
  const info = readOfflineHelpInfo(root)
  if (!info) {
    appLogger.error('offline help bundle is missing or invalid', { root })
    void showHelpUnavailable()
    return
  }
  openHelpWindow({
    root,
    info,
    show: !e2eBackground,
    icon: getBrandIconPath(),
    backgroundColor: windowBackgroundColor(),
    logger: appLogger,
  })
}

async function showHelpUnavailable(): Promise<void> {
  const owner = mainWindow ?? BrowserWindow.getFocusedWindow()
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Help Not Available',
    message: 'This copy of Statekeep does not include its offline Help.',
    detail: `The same documentation is online at:\n${DOCUMENTATION_URL}`,
    buttons: ['Open Online Documentation', 'Close'],
    defaultId: 0,
    cancelId: 1,
  }
  const result = owner && !owner.isDestroyed()
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options)
  if (result.response === 0) await openOnlineDocumentation()
}

async function openOnlineDocumentation(): Promise<void> {
  try {
    await shell.openExternal(DOCUMENTATION_URL)
  } catch (error: unknown) {
    appLogger.error('failed to open online documentation', { error: errorMessage(error), url: DOCUMENTATION_URL })
    await showMessageBoxSafely('online documentation error dialog', mainWindow ?? BrowserWindow.getFocusedWindow(), {
      type: 'error',
      title: 'Could Not Open Documentation',
      message: 'Statekeep could not open the online documentation in your browser.',
      detail: `Open this address in a browser:\n${DOCUMENTATION_URL}\n\nHelp → Statekeep Help has the same documentation and works without internet access.`,
      buttons: ['OK'],
    })
  }
}

async function openReleasesPage(): Promise<void> {
  // Only the user's menu action opens a browser; no update request runs in the background.
  try {
    await shell.openExternal(RELEASES_URL)
  } catch (error: unknown) {
    appLogger.error('failed to open releases page', { error: errorMessage(error), url: RELEASES_URL })
    await showMessageBoxSafely('releases page error dialog', mainWindow ?? BrowserWindow.getFocusedWindow(), {
      type: 'error',
      title: 'Could Not Open Releases',
      message: 'Statekeep could not open the releases page in your browser.',
      detail: `Open this address in a browser to view available releases:\n${RELEASES_URL}\n\nYour local projects can still be used without internet access.`,
      buttons: ['OK'],
    })
  }
}

async function reportIssue(): Promise<void> {
  try {
    await shell.openExternal(REPORT_ISSUE_URL)
    return
  } catch (error: unknown) {
    appLogger.error('failed to open issue report link', { error: errorMessage(error), url: REPORT_ISSUE_URL })
  }

  // Without a browser the user files the report from another device, so put
  // the details they would otherwise have to collect on the clipboard.
  let copied = false
  try {
    await clipboard.writeText(await collectDiagnostics())
    copied = true
  } catch (error: unknown) {
    appLogger.error('failed to copy diagnostics for issue report', { error: errorMessage(error) })
  }
  await showMessageBoxSafely('issue report error dialog', mainWindow ?? BrowserWindow.getFocusedWindow(), {
    type: 'error',
    title: 'Could Not Open Issue Form',
    message: 'Statekeep could not open the issue form in your browser.',
    detail: [
      `Open this address in a browser to report an issue:\n${REPORT_ISSUE_URL}`,
      copied
        ? 'Diagnostics were copied to the clipboard. Paste them into the report so it includes your app version and system details.'
        : 'Diagnostics could not be copied. Use Help → Copy Diagnostics, then paste them into the report.',
    ].join('\n\n'),
    buttons: ['OK'],
  })
}

function copyDiagnostics(): void {
  copyDiagnosticsToClipboard().catch((error: unknown) => {
    appLogger.error('failed to copy diagnostics from menu', { error: errorMessage(error) })
  })
}

async function exportDiagnostics(): Promise<void> {
  try {
    const selected = await dialog.showSaveDialog({
      title: 'Export Diagnostics Bundle',
      defaultPath: `Statekeep-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'Diagnostics bundle', extensions: ['json'] }],
    })
    if (selected.canceled || !selected.filePath) return
    const bundle = await buildDiagnosticsBundle(await collectDiagnostics(), logDir)
    await writeFile(selected.filePath, bundle, { encoding: 'utf8', mode: 0o600 })
    await showMessageBoxSafely('diagnostics export complete', mainWindow, {
      type: 'info', title: 'Diagnostics Exported', message: 'Diagnostics were saved locally.',
      detail: 'The bundle includes runtime details and recent log event labels. Local paths, project content, and log context fields are omitted. Review the file before sharing; nothing was uploaded.',
      buttons: ['OK'],
    })
  } catch (error) {
    appLogger.error('diagnostics export failed', { error: errorMessage(error) })
    await showMessageBoxSafely('diagnostics export error', mainWindow, {
      type: 'error', title: 'Could Not Export Diagnostics', message: 'The diagnostics bundle could not be saved.',
      detail: 'Choose a writable location and try again. Help → Copy Diagnostics is also available.', buttons: ['OK'],
    })
  }
}

async function collectDiagnostics(): Promise<string> {
  return buildDiagnostics({
    appName: app.name || 'Statekeep',
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    gitStatus: await gitService.checkVersion(),
    projectPath: projectManager.getCurrent()?.path ?? null,
    logsPath: logDir,
    userDataPath: userData,
  })
}

async function copyDiagnosticsToClipboard(): Promise<void> {
  const diagnostics = await collectDiagnostics()
  await clipboard.writeText(diagnostics)

  const owner = mainWindow ?? BrowserWindow.getFocusedWindow()
  const options = {
    type: 'info' as const,
    title: 'Diagnostics Copied',
    message: 'Diagnostics copied to the clipboard.',
    detail: diagnostics,
    buttons: ['OK'],
  }
  await showMessageBoxSafely('diagnostics copied dialog', owner, options)
}

function openExternalSafely(url: string, label: string): void {
  shell.openExternal(url).catch((error: unknown) => {
    appLogger.error(`failed to open ${label}`, { error: errorMessage(error), url })
  })
}

function configureRendererNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      openExternalSafely(url, 'external renderer link')
    } else {
      appLogger.warn('blocked unsafe renderer window request', { url })
    }
    return { action: 'deny' }
  })

  const blockUntrustedNavigation = (event: Electron.Event, url: string) => {
    if (isTrustedRendererUrl(url)) return
    event.preventDefault()
    appLogger.warn('blocked renderer navigation', { url })
  }
  win.webContents.on('will-navigate', blockUntrustedNavigation)
  win.webContents.on('will-redirect', blockUntrustedNavigation)
}

function notifyWindowFocusChanged(win: BrowserWindow, isFocused: boolean): void {
  if (win.isDestroyed()) return
  win.webContents.send(IPC.WINDOW_FOCUS_CHANGED, isFocused)
}

function isTrustedRendererUrl(url: string): boolean {
  return isTrustedRendererNavigationUrl(url, {
    devServerUrl: app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'],
    rendererDirectory: join(__dirname, '../renderer'),
  })
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

async function showMessageBoxSafely(
  label: string,
  owner: BrowserWindow | null,
  options: Electron.MessageBoxOptions,
): Promise<void> {
  if (owner && !owner.isDestroyed()) {
    await dialog.showMessageBox(owner, options).catch((error: unknown) => {
      appLogger.error(`failed to show ${label}`, { error: errorMessage(error) })
    })
  } else {
    await dialog.showMessageBox(options).catch((error: unknown) => {
      appLogger.error(`failed to show ${label}`, { error: errorMessage(error) })
    })
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function trackRecentProject(result: Result<Project>): void {
  if (!result.ok) return
  if (typeof result.data.path !== 'string' || result.data.path.trim() === '') return
  appSettings.recordLastProject(result.data)
  recentProjects.add(result.data)
  const documentPath = getRecentDocumentPath(result.data.path)
  if (documentPath) app.addRecentDocument(documentPath)
  updateApplicationMenuRecentProjects(recentProjects.all())
}

function directoryKindForFolderDialogPurpose(purpose: FolderDialogPurpose | undefined): 'open' | 'create' | null {
  if (purpose === 'open-project') return 'open'
  if (purpose === 'create-project') return 'create'
  return null
}

function normalizeWorkspaceSettingsPatch(input: unknown): WorkspaceSettingsPatch {
  if (!input || typeof input !== 'object') return {}
  const source = input as Record<string, unknown>
  const patch: WorkspaceSettingsPatch = {}
  if (typeof source.treeWidth === 'number') patch.treeWidth = source.treeWidth
  if (typeof source.tableWidth === 'number') patch.tableWidth = source.tableWidth
  if (typeof source.panelWidth === 'number') patch.panelWidth = source.panelWidth
  if (source.lastOpenDirectory === null || typeof source.lastOpenDirectory === 'string') {
    patch.lastOpenDirectory = source.lastOpenDirectory
  }
  if (source.lastCreateDirectory === null || typeof source.lastCreateDirectory === 'string') {
    patch.lastCreateDirectory = source.lastCreateDirectory
  }
  return patch
}

function normalizePreferencesPatch(input: unknown): AppPreferencesPatch {
  if (!input || typeof input !== 'object') return {}
  const source = input as Record<string, unknown>
  const patch: AppPreferencesPatch = {}
  if (source.launchBehavior === 'project-hub' || source.launchBehavior === 'reopen-last-project') {
    patch.launchBehavior = source.launchBehavior
  }
  if (source.appearance && typeof source.appearance === 'object') {
    const appearance = source.appearance as Record<string, unknown>
    const appearancePatch: NonNullable<AppPreferencesPatch['appearance']> = {}
    if (isAppearanceMode(appearance.mode)) appearancePatch.mode = appearance.mode
    if (typeof appearance.lightThemeId === 'string') appearancePatch.lightThemeId = appearance.lightThemeId
    if (typeof appearance.darkThemeId === 'string') appearancePatch.darkThemeId = appearance.darkThemeId
    if (Object.keys(appearancePatch).length > 0) patch.appearance = appearancePatch
  }
  return patch
}

function resetMainWindowLayout(settings: WorkspaceSettings): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (win.isFullScreen()) win.setFullScreen(false)
  if (win.isMaximized()) win.unmaximize()
  win.setSize(1280, 800)
  win.center()
  win.webContents.send(IPC.SETTINGS_LAYOUT_RESET, settings)
}

function notifyProjectOpenFromOs(
  result: Result<Project>,
  options: { notifyRenderer: boolean }
): void {
  if (!options.notifyRenderer) return
  // Not getAllWindows()[0]: on macOS that can be Help, which has no project UI.
  const win = mainWindow
  if (!win || win.isDestroyed()) {
    // A new project window loads the open project itself.
    if (result.ok) {
      if (startupWindowCreated) createWindow()
      return
    }
    void dialog.showMessageBox({
      type: 'error',
      title: 'Could Not Open Project',
      message: result.error.message,
      buttons: ['OK'],
    })
    return
  }
  if (!result.ok) {
    void dialog.showMessageBox(win, {
      type: 'error',
      title: 'Could Not Open Project',
      message: result.error.message,
      buttons: ['OK'],
    })
  }
  win.webContents.send(IPC.PROJECT_OPENED_FROM_OS, result)
  if (result.ok) focusMainWindow()
}

function focusMainWindow(): void {
  if (e2eBackground) return
  const win = mainWindow
  if (!win || win.isDestroyed()) {
    // Only Help is open (macOS keeps the app running): bring the project window back.
    if (startupWindowCreated) createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function launchEnvironment(): LaunchArgumentEnvironment {
  return { defaultApp: process.defaultApp === true, appPath: app.getAppPath() }
}

function collectOpenTargetsFromArgv(argv: string[]): string[] {
  return collectProjectOpenTargets(argv, launchEnvironment())
}
