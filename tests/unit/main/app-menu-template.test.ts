import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { buildAppMenuTemplate } from '../../../src/main/app-menu-template'
import { MENU_COMMAND_IDS, type MenuCommandId } from '../../../src/shared/menu-commands'
import type { RecentProjectMenuEntry } from '../../../src/main/recent-projects'

function templateFor(
  platform: NodeJS.Platform,
  isDev = false,
  recentProjects: RecentProjectMenuEntry[] = [],
  calls: string[] = [],
): MenuItemConstructorOptions[] {
  return buildAppMenuTemplate({
    platform,
    isDev,
    appName: 'Statekeep',
    recentProjects,
    dispatch: () => {},
    openRecentProject: () => {},
    clearRecentProjects: () => {},
    openPreferences: () => {},
    openHelp: () => { calls.push('openHelp') },
    openOnlineDocumentation: () => { calls.push('openOnlineDocumentation') },
    openReleasesPage: () => { calls.push('openReleasesPage') },
    reportIssue: () => { calls.push('reportIssue') },
    openLogsFolder: () => { calls.push('openLogsFolder') },
    copyDiagnostics: () => { calls.push('copyDiagnostics') },
    exportDiagnostics: () => { calls.push('exportDiagnostics') },
  })
}

function submenu(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  return Array.isArray(item.submenu) ? item.submenu : []
}

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const all: MenuItemConstructorOptions[] = []
  for (const item of items) {
    all.push(item)
    all.push(...flatten(submenu(item)))
  }
  return all
}

function fileMenu(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions {
  const menu = template.find(item => item.label === 'File')
  if (!menu) throw new Error('File menu not found')
  return menu
}

function openRecentMenu(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions {
  const menu = submenu(fileMenu(template)).find(item => item.label === 'Open Recent')
  if (!menu) throw new Error('Open Recent menu not found')
  return menu
}

describe('buildAppMenuTemplate', () => {
  it('uses a macOS app menu and omits File quit on darwin', () => {
    const template = templateFor('darwin')
    const labels = template.map(item => item.label)

    expect(labels[0]).toBe('Statekeep')
    expect(submenu(fileMenu(template)).some(item => item.role === 'quit')).toBe(false)
    expect(submenu(template[0]!).some(item => item.role === 'quit')).toBe(true)
    expect(submenu(template[0]!).some(item => item.label === 'Settings...')).toBe(true)
  })

  it('puts quit under File on non-mac platforms', () => {
    const template = templateFor('win32')
    const labels = template.map(item => item.label)

    expect(labels[0]).toBe('File')
    expect(submenu(fileMenu(template)).some(item => item.role === 'quit')).toBe(true)
    expect(submenu(fileMenu(template)).some(item => item.label === 'Settings...')).toBe(true)
  })

  it('renders every shared command exactly once and disabled by default', () => {
    const commands = flatten(templateFor('linux'))
      .filter(item => typeof item.id === 'string' && MENU_COMMAND_IDS.includes(item.id as MenuCommandId))

    expect(commands.map(item => item.id).sort()).toEqual([...MENU_COMMAND_IDS].sort())
    expect(commands.every(item => item.enabled === false)).toBe(true)
  })

  it('uses the window close role and gives project close a separate shortcut', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const all = flatten(templateFor(platform))
      expect(all.some(item => item.role === 'close')).toBe(true)
      expect(all.find(item => item.id === 'project:close')?.accelerator).toBe('CommandOrControl+Shift+W')
      for (const id of ['node:addChild', 'node:addSibling', 'node:moveUp', 'node:moveDown', 'node:moveTo', 'node:delete', 'snapshot:create', 'compare:start']) {
        expect(all.find(item => item.id === id)?.accelerator).toBeTruthy()
      }
    }
  })

  it('offers HTML, Markdown, and CSV report exports', () => {
    const exportMenu = submenu(fileMenu(templateFor('linux'))).find(item => item.label === 'Export Report')
    if (!exportMenu) throw new Error('Export Report menu not found')
    expect(submenu(exportMenu).map(item => item.label)).toEqual([
      'Export HTML Review...',
      'Export Markdown Report...',
      'Export CSV Report...',
    ])
  })

  it('gates reload and devtools to development menus', () => {
    const productionRoles = flatten(templateFor('linux', false)).map(item => item.role)
    const devRoles = flatten(templateFor('linux', true)).map(item => item.role)

    expect(productionRoles).not.toContain('reload')
    expect(productionRoles).not.toContain('toggleDevTools')
    expect(devRoles).toContain('reload')
    expect(devRoles).toContain('toggleDevTools')
  })

  it('renders an Open Recent submenu with disabled empty and clear states', () => {
    const recentMenu = openRecentMenu(templateFor('linux'))
    const items = submenu(recentMenu)

    expect(items.map(item => item.label)).toEqual(['No Recent Projects', undefined, 'Clear Menu'])
    expect(items[0]!.enabled).toBe(false)
    expect(items[2]!.enabled).toBe(false)
  })

  it('renders recent projects and annotates missing paths', () => {
    const recentMenu = openRecentMenu(templateFor('linux', false, [
      {
        path: '/tmp/Lab',
        name: 'Lab',
        openedAt: '2026-07-01T00:00:00.000Z',
        exists: true,
      },
      {
        path: '/tmp/Missing',
        name: 'Missing',
        openedAt: '2026-07-01T00:00:00.000Z',
        exists: false,
      },
    ]))
    const items = submenu(recentMenu)

    expect(items[0]).toMatchObject({ label: 'Lab', sublabel: '/tmp/Lab', enabled: true })
    expect(items[1]).toMatchObject({ label: 'Missing (Missing)', sublabel: '/tmp/Missing', enabled: false })
    expect(items[3]).toMatchObject({ label: 'Clear Menu' })
  })

  it.each(['linux', 'win32'] as const)('puts local Help first and About last on %s', (platform) => {
    const helpMenu = templateFor(platform).find(item => item.label === 'Help')
    if (!helpMenu) throw new Error('Help menu not found')

    expect(submenu(helpMenu).map(item => item.label ?? item.role ?? item.type)).toEqual([
      'Statekeep Help',
      'Online Documentation',
      'separator',
      'Check for Updates...',
      'Report an Issue...',
      'separator',
      'Open Logs Folder',
      'Copy Diagnostics',
      'Export Diagnostics Bundle...',
      'separator',
      'about',
    ])
  })

  it('leaves About in the app menu on macOS', () => {
    const helpMenu = templateFor('darwin').find(item => item.label === 'Help')
    if (!helpMenu) throw new Error('Help menu not found')

    expect(submenu(helpMenu).map(item => item.label ?? item.type)).toEqual([
      'Statekeep Help',
      'Online Documentation',
      'separator',
      'Check for Updates...',
      'Report an Issue...',
      'separator',
      'Open Logs Folder',
      'Copy Diagnostics',
      'Export Diagnostics Bundle...',
    ])
  })

  it('wires each Help item to its own action', () => {
    const calls: string[] = []
    const helpMenu = templateFor('linux', false, [], calls).find(item => item.label === 'Help')
    if (!helpMenu) throw new Error('Help menu not found')

    for (const item of submenu(helpMenu)) {
      if (typeof item.click === 'function') (item.click as () => void)()
    }

    expect(calls).toEqual([
      'openHelp',
      'openOnlineDocumentation',
      'openReleasesPage',
      'reportIssue',
      'openLogsFolder',
      'copyDiagnostics',
      'exportDiagnostics',
    ])
  })
})
