import { app, BrowserWindow, Menu, shell, type MenuItem } from 'electron'
import { IPC } from '../shared/ipc'
import {
  MENU_COMMAND_IDS,
  normalizeMenuCommandState,
  type MenuCommandId,
  type MenuCommandState,
} from '../shared/menu-commands'
import { buildAppMenuTemplate } from './app-menu-template'
import type { RecentProjectMenuEntry } from './recent-projects'
import type { Logger } from './logger'
import { isHelpWindow } from './help-window'

let commandItems = new Map<MenuCommandId, MenuItem>()
let commandState = normalizeMenuCommandState(null)
let installOptions: {
  platform: NodeJS.Platform
  isDev: boolean
  appName: string
  logsPath: string
  logger: Logger
  openRecentProject(path: string): void
  clearRecentProjects(): void
  openPreferences(): void
  openHelp(): void
  openOnlineDocumentation(): void
  openReleasesPage(): void
  reportIssue(): void
  copyDiagnostics(): void
  exportDiagnostics(): void
  showProjectWindow(): void
} | null = null
let recentProjects: RecentProjectMenuEntry[] = []

// Settings is a child window: its text editing must never undo the main project.
app.on('browser-window-focus', () => updateApplicationMenuState(commandState))

export function installApplicationMenu(options: {
  platform: NodeJS.Platform
  isDev: boolean
  appName: string
  logsPath: string
  logger: Logger
  recentProjects: RecentProjectMenuEntry[]
  openRecentProject(path: string): void
  clearRecentProjects(): void
  openPreferences(): void
  openHelp(): void
  openOnlineDocumentation(): void
  openReleasesPage(): void
  reportIssue(): void
  copyDiagnostics(): void
  exportDiagnostics(): void
  showProjectWindow(): void
}): void {
  installOptions = {
    platform: options.platform,
    isDev: options.isDev,
    appName: options.appName,
    logsPath: options.logsPath,
    logger: options.logger,
    openRecentProject: options.openRecentProject,
    clearRecentProjects: options.clearRecentProjects,
    openPreferences: options.openPreferences,
    openHelp: options.openHelp,
    openOnlineDocumentation: options.openOnlineDocumentation,
    openReleasesPage: options.openReleasesPage,
    reportIssue: options.reportIssue,
    copyDiagnostics: options.copyDiagnostics,
    exportDiagnostics: options.exportDiagnostics,
    showProjectWindow: options.showProjectWindow,
  }
  recentProjects = options.recentProjects
  rebuildApplicationMenu()
}

export function updateApplicationMenuRecentProjects(nextProjects: RecentProjectMenuEntry[]): void {
  recentProjects = nextProjects
  rebuildApplicationMenu()
}

function rebuildApplicationMenu(): void {
  if (!installOptions) return
  const options = installOptions
  const menu = Menu.buildFromTemplate(buildAppMenuTemplate({
    platform: options.platform,
    isDev: options.isDev,
    appName: options.appName,
    recentProjects,
    dispatch: dispatchMenuCommand,
    // Recent entries are direct main-process callbacks, so they must honor
    // the same dialog/busy policy as the renderer's Open command.
    openRecentProject: path => {
      if (commandState['project:open']) options.openRecentProject(path)
    },
    clearRecentProjects: options.clearRecentProjects,
    openPreferences: options.openPreferences,
    openHelp: options.openHelp,
    openOnlineDocumentation: options.openOnlineDocumentation,
    openReleasesPage: options.openReleasesPage,
    reportIssue: options.reportIssue,
    openLogsFolder: () => {
      shell.openPath(options.logsPath).catch((error: unknown) => {
        options.logger.error('failed to open logs folder from menu', { error: errorMessage(error), path: options.logsPath })
      })
    },
    copyDiagnostics: options.copyDiagnostics,
    exportDiagnostics: options.exportDiagnostics,
  }))

  Menu.setApplicationMenu(menu)
  commandItems = new Map<MenuCommandId, MenuItem>()
  for (const id of MENU_COMMAND_IDS) {
    const item = menu.getMenuItemById(id)
    if (item) commandItems.set(id, item)
  }
  updateApplicationMenuState(commandState)
}

export function updateApplicationMenuState(nextState: unknown): void {
  commandState = normalizeMenuCommandState(nextState)
  const recent = Menu.getApplicationMenu()?.getMenuItemById('open-recent-projects')
  if (recent) recent.enabled = commandState['project:open']
  for (const id of MENU_COMMAND_IDS) {
    const item = commandItems.get(id)
    if (item) item.enabled = commandState[id] ||
      (isUndoRedo(id) && editsOwnContents(BrowserWindow.getFocusedWindow()))
  }
}

export function currentApplicationMenuState(): MenuCommandState {
  return { ...commandState }
}

function dispatchMenuCommand(command: MenuCommandId): void {
  const focused = BrowserWindow.getFocusedWindow()
  // Project commands chosen while Help is in front still apply to the project.
  const target = focused && (!isHelpWindow(focused) || isUndoRedo(command))
    ? focused
    : BrowserWindow.getAllWindows().find(win => !isHelpWindow(win))
  if (!target || target.isDestroyed()) {
    // On macOS Help can outlive the project window. Bring the project window
    // back; its project hub offers New and Open itself.
    installOptions?.showProjectWindow()
    return
  }
  if (editsOwnContents(target) && isUndoRedo(command)) {
    target.webContents[command === 'project:undo' ? 'undo' : 'redo']()
    return
  }
  if (!commandState[command]) return
  // A command chosen from Help acts on the project window, so show it.
  if (target !== focused) {
    if (target.isMinimized()) target.restore()
    target.show()
    target.focus()
  }
  target.webContents.send(IPC.MENU_COMMAND, command)
}

function isUndoRedo(command: MenuCommandId): boolean {
  return command === 'project:undo' || command === 'project:redo'
}

// Settings (a child window) and Help have their own text fields, so undo and
// redo there edit those fields and never the project.
function editsOwnContents(win: BrowserWindow | null): boolean {
  return Boolean(win?.getParentWindow()) || isHelpWindow(win)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
