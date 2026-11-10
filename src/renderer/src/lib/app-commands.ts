// Command availability for the project window: which native-menu commands
// and toolbar actions are enabled for the current UI state.
//
// These are pure functions over a plain snapshot of App.svelte's state so the
// enable/disable matrix can be unit tested without mounting the app. App.svelte
// still owns the state; it builds a CommandContext from its runes and passes it
// here. The field names mirror App's state variables one-for-one, and the
// expressions below are the ones App used inline, including their truthiness
// checks (e.g. `!duplicateNodeId` vs `duplicateNodeId !== null`).

import { createDisabledMenuCommandState, type MenuCommandState } from '../../../shared/menu-commands'
import type { EditHistoryState, ProjectNode } from '../../../shared/types'

export type AppState = 'welcome' | 'creating' | 'loading' | 'open'

export interface CommandContext {
  appState: AppState
  hasProject: boolean
  creating: boolean
  editingLocked: boolean
  textEditing: boolean
  undoRedoBusy: boolean
  editHistory: EditHistoryState
  // Overlays and in-flight operations.
  archiveOpen: boolean
  importDialogOpen: boolean
  templateManagerOpen: boolean
  batchDialogOpen: boolean
  duplicateNodeId: string | null
  moveToNodeId: string | null
  addingChildTo: string | null
  revertDialogSnapshotName: string | null
  recoveryDialogPoint: unknown | null
  snapshotCreating: boolean
  snapshotComparing: boolean
  snapshotRestoringName: string | null
  recoveryApplyingId: string | null
  // Selection and compare.
  selectedId: string | null
  selectedCount: number
  selectedNode: Pick<ProjectNode, 'parentId'> | null
  compareMode: boolean
  compareLoaded: boolean
}

/** Project-level undo/redo is allowed only when no dialog or operation could race it. */
export function canUndoProject(ctx: CommandContext): boolean {
  return ctx.appState === 'open' && ctx.hasProject && !ctx.editingLocked &&
    !ctx.archiveOpen && !ctx.snapshotCreating && !ctx.snapshotComparing && !ctx.importDialogOpen && !ctx.templateManagerOpen &&
    !ctx.duplicateNodeId && !ctx.batchDialogOpen && !ctx.moveToNodeId && !ctx.addingChildTo && !ctx.revertDialogSnapshotName && !ctx.recoveryDialogPoint
}

export function buildMenuCommandState(ctx: CommandContext): MenuCommandState {
  const state = createDisabledMenuCommandState()
  const hasOpenProject = ctx.appState === 'open' && ctx.hasProject
  const projectBusy = ctx.duplicateNodeId !== null || ctx.batchDialogOpen || ctx.undoRedoBusy || ctx.snapshotCreating || ctx.snapshotRestoringName !== null || ctx.recoveryApplyingId !== null
  const canUseProject = hasOpenProject && !projectBusy
  const canEditProject = canUseProject && !ctx.editingLocked
  const selectedLiveNode = canEditProject && ctx.selectedCount === 1 && ctx.selectedNode && !ctx.selectedId?.startsWith('ghost:')
    ? ctx.selectedNode
    : null
  const selectedEditableChild = selectedLiveNode !== null && selectedLiveNode.parentId !== null
  const compareLoaded = hasOpenProject && ctx.compareMode && ctx.compareLoaded
  const canMutateSelectedChild = Boolean(selectedEditableChild) && !ctx.textEditing &&
    !ctx.importDialogOpen && !ctx.templateManagerOpen && !ctx.archiveOpen && !ctx.moveToNodeId && !ctx.addingChildTo &&
    !ctx.snapshotComparing && !ctx.revertDialogSnapshotName && !ctx.recoveryDialogPoint
  const canUndo = canUndoProject(ctx)

  state['project:undo'] = ctx.textEditing || (canUndo && ctx.editHistory.undoLabel !== null)
  state['project:redo'] = ctx.textEditing || (canUndo && ctx.editHistory.redoLabel !== null)
  // Native accelerators can run even while the DOM background is inert. Do
  // not open a second overlay, switch/close the project, or mutate selection
  // behind the current dialog. Field-level native Undo/Redo stays available.
  const dialogOpen = ctx.archiveOpen || ctx.importDialogOpen || ctx.templateManagerOpen ||
    ctx.batchDialogOpen || ctx.duplicateNodeId !== null || ctx.moveToNodeId !== null ||
    ctx.revertDialogSnapshotName !== null || ctx.recoveryDialogPoint !== null
  if (dialogOpen) return state
  state['project:new'] = ctx.appState === 'welcome' && !ctx.hasProject
  state['project:open'] = ctx.appState !== 'loading' && ctx.appState !== 'creating' && !ctx.creating && !projectBusy
  state['project:save'] = canUseProject
  state['project:close'] = canUseProject
  state['project:import'] = canEditProject
  state['project:templates'] = canEditProject
  state['project:snapshots'] = canUseProject
  state['project:search'] = canUseProject && !ctx.compareMode
  state['snapshot:create'] = canEditProject && !ctx.importDialogOpen && !ctx.templateManagerOpen && !ctx.archiveOpen && !ctx.moveToNodeId && !ctx.addingChildTo && !ctx.snapshotComparing && !ctx.revertDialogSnapshotName && !ctx.recoveryDialogPoint
  state['compare:start'] = canUseProject && !ctx.compareMode && !ctx.importDialogOpen && !ctx.templateManagerOpen && !ctx.archiveOpen && !ctx.moveToNodeId && !ctx.addingChildTo && !ctx.snapshotComparing && !ctx.revertDialogSnapshotName && !ctx.recoveryDialogPoint
  state['compare:exit'] = compareLoaded && !projectBusy
  state['report:copyMarkdown'] = compareLoaded && !projectBusy
  state['report:exportMarkdown'] = compareLoaded && !projectBusy
  state['report:exportCsv'] = compareLoaded && !projectBusy
  state['report:exportHtml'] = compareLoaded && !projectBusy
  state['node:addChild'] = selectedLiveNode !== null && !ctx.textEditing && !ctx.importDialogOpen && !ctx.templateManagerOpen && !ctx.archiveOpen && !ctx.moveToNodeId && !ctx.addingChildTo && !ctx.snapshotComparing && !ctx.revertDialogSnapshotName && !ctx.recoveryDialogPoint
  state['node:addSibling'] = canMutateSelectedChild
  state['node:moveUp'] = canMutateSelectedChild
  state['node:moveDown'] = canMutateSelectedChild
  state['node:rename'] = selectedLiveNode !== null
  state['node:duplicate'] = canMutateSelectedChild
  state['node:moveTo'] = canMutateSelectedChild
  state['node:delete'] = canMutateSelectedChild
  state['history:reindex'] = canUseProject

  return state
}

export type EditShortcut = 'duplicate' | 'undo' | 'redo'

/**
 * Map a window-level keydown to a project edit shortcut, or null. The caller
 * has already excluded text-editing targets; this only reads the key chord.
 * Cmd is the modifier on macOS, Ctrl elsewhere; Ctrl+Y is also redo.
 */
export function editShortcutFor(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey'>,
  platform: string,
): EditShortcut | null {
  const modifier = platform === 'darwin' ? event.metaKey : event.ctrlKey
  if (!modifier) return null
  const key = event.key.toLowerCase()
  if (key === 'd' && !event.shiftKey) return 'duplicate'
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (key === 'y' && event.ctrlKey) return 'redo'
  return null
}
