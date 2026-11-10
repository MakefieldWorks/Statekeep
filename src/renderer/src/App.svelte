<svelte:options runes />

<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte'
  import ProjectArchive from './components/ProjectArchive.svelte'
  import ExternalDocumentConflict from './components/ExternalDocumentConflict.svelte'
  import InterruptedHistory from './components/InterruptedHistory.svelte'
  let interruptedHistory = $state(false)
  let externalDocumentConflict = $state(false)
  let archiveOpen = $state(false)
  import type { EditHistoryState, Project, ProjectNode, DocumentWarning, ProjectWarning, NodeTemplate, PropertyType, RecoveryPoint, SearchResult, Snapshot, SnapshotTimelineEvent, ImportResult } from '../../shared/types'
  import { isUsableTemplate } from '../../shared/validation'
  import { CURRENT_PROJECT_REF } from '../../shared/snapshot-ref'
  import type { MenuCommandId, MenuCommandState } from '../../shared/menu-commands'
  import type { MergedTree } from '../../shared/merged-tree'
  import { computeSubtreeSummaries, templatesForNode } from '../../shared/merged-tree'
  import type { RecentProject, WorkspaceSettings } from '../../shared/ipc'
  import type { BatchPropertyUpdateRequest } from '../../shared/batch-properties'
  import type { ReportFormat } from '../../shared/report'
  import { hasInventoryFilters, type InventoryFilters } from '../../shared/inventory-filters'
  import { DEFAULT_INVENTORY_COLUMNS, type InventoryColumn, type InventorySortDirection } from '../../shared/inventory-table'
  import { buildTree, getSiblingIndex, getDescendantIds } from './lib/tree'
  import { flattenTree } from './lib/tree-rows'
  import { isTextEditing } from './lib/edit-focus'
  import { cycleIndex } from './lib/tree-typeahead'
  import {
    buildMenuCommandState as buildMenuCommandStateFor,
    canUndoProject as canUndoProjectFor,
    editShortcutFor,
    type AppState,
    type CommandContext,
  } from './lib/app-commands'
  import { pruneSelection, selectWithModifiers, singleSelection, type SelectionState } from './lib/selection'
  import { expandToReveal, resolveCompareSelectionId, scopeSelectionId, seedCompareExpanded } from './lib/compare-session'
  import { detailReadOnlyReason, editLockReason, formatProjectMode, isEditingLocked, type CompareLabels, type EditLockState } from './lib/project-status'
  import { inventoryFilterCount as countInventoryFilters, searchRevealIds } from './lib/inventory-search'
  import { deleteSubtreeConfirmMessage, referenceBlockersConfirmMessage, referenceBlockersFromContext } from './lib/node-delete'
  import {
    DEFAULT_PANEL_WIDTH,
    DEFAULT_TABLE_WIDTH,
    DEFAULT_TREE_WIDTH,
    WORKSPACE_SETTINGS_SAVE_DELAY_MS,
    dragPaneWidth,
    roundPaneWidths,
    serializeWorkspacePaneSettings,
    type PaneHandle,
  } from './lib/pane-layout'
  import ProjectTreeView from './components/ProjectTreeView.svelte'
  import DetailPane from './components/DetailPane.svelte'
  import MoveToDialog from './components/MoveToDialog.svelte'
  import DuplicateDialog from './components/DuplicateDialog.svelte'
  import BatchSelectionPane from './components/BatchSelectionPane.svelte'
  import BatchPropertyDialog from './components/BatchPropertyDialog.svelte'
  import InventoryFilterPanel from './components/InventoryFilterPanel.svelte'
  import InventoryTable from './components/InventoryTable.svelte'
  import TemplateManager from './components/TemplateManager.svelte'
  import ImportDialog from './components/ImportDialog.svelte'
  import RecoveryDialog from './components/RecoveryDialog.svelte'
  import RevertDialog from './components/RevertDialog.svelte'
  import SnapshotsPanel from './components/SnapshotsPanel.svelte'
  import WelcomeScreen from './components/WelcomeScreen.svelte'
  import CreateProjectForm from './components/CreateProjectForm.svelte'
  import ProjectTitlebar from './components/ProjectTitlebar.svelte'
  import ProjectWarningsBanner from './components/ProjectWarningsBanner.svelte'
  import LoadWarningsBanner from './components/LoadWarningsBanner.svelte'
  import ImportSummaryBanner from './components/ImportSummaryBanner.svelte'
  import InventorySearchBar from './components/InventorySearchBar.svelte'
  import AddChildForm from './components/AddChildForm.svelte'
  import PaneResizeHandle from './components/PaneResizeHandle.svelte'

  let editHistory: EditHistoryState = $state({ undoLabel: null, redoLabel: null })
  let undoRedoBusy = $state(false)
  let textEditing = $state(false)
  let duplicateNodeId = $state<string | null>(null)
  const duplicateNode = $derived.by(() => project?.nodes.find(node => node.id === duplicateNodeId))

  function updateEditFocus(event: FocusEvent) {
    const sync = () => { textEditing = isTextEditing(document.activeElement) }
    // A removed dialog input can still be document.activeElement while its
    // focusout event is dispatching. Re-read after focus settles so native
    // edit commands do not remain disabled after the dialog closes.
    if (event.type === 'focusout') queueMicrotask(sync)
    else sync()
  }

  function handleEditKeydown(event: KeyboardEvent) {
    if (event.isComposing || event.altKey || isTextEditing(document.activeElement)) return
    const shortcut = editShortcutFor(event, desktopChrome.platform)
    if (!shortcut) return
    event.preventDefault()
    event.stopPropagation()
    if (shortcut === 'duplicate') void runMenuCommand('node:duplicate')
    else void applyUndoRedo(shortcut)
  }

  // Cancel stale replies when another edit, close, or project switch wins the race.
  $effect(() => {
    const current = project
    let cancelled = false
    editHistory = { undoLabel: null, redoLabel: null }
    if (current) {
      void window.api.project.editHistory().then(result => {
        if (!cancelled && result.ok) editHistory = result.data
      })
    }
    return () => { cancelled = true }
  })

  // Everything the command-availability rules in lib/app-commands read. Built
  // as a $derived so menu state, undo buttons, and keyboard shortcuts all see
  // the same snapshot of App's state.
  const commandContext = $derived.by<CommandContext>(() => ({
    appState,
    hasProject: project !== null,
    creating,
    editingLocked,
    textEditing,
    undoRedoBusy,
    editHistory,
    archiveOpen,
    importDialogOpen,
    templateManagerOpen,
    batchDialogOpen,
    duplicateNodeId,
    moveToNodeId,
    addingChildTo,
    revertDialogSnapshotName,
    recoveryDialogPoint,
    snapshotCreating,
    snapshotComparing,
    snapshotRestoringName,
    recoveryApplyingId,
    selectedId,
    selectedCount: selectedIds.size,
    selectedNode,
    compareMode,
    compareLoaded: mergedTree !== null,
  }))

  const canUndoProject = $derived(canUndoProjectFor(commandContext))

  async function applyUndoRedo(direction: 'undo' | 'redo') {
    if (!canUndoProject || !editHistory[direction === 'undo' ? 'undoLabel' : 'redoLabel']) return
    const label = editHistory[direction === 'undo' ? 'undoLabel' : 'redoLabel']
    undoRedoBusy = true
    try {
      const result = await window.api.project[direction]()
      if (!result.ok) { showToast(result.error.message); return }
      applyProject(result.data)
      markWorkingCopyChanged()
      if (workingCopyBaseSnapshot) {
        const comparison = await window.api.snapshot.loadCompare(workingCopyBaseSnapshot, CURRENT_PROJECT_REF)
        if (comparison.ok) workingCopyDirty = comparison.data.nodes.some(node => node.status !== 'unchanged') ||
          (comparison.data.templateChanges?.length ?? 0) > 0
      }
      showToast(`${direction === 'undo' ? 'Undid' : 'Redid'} ${label?.toLowerCase()}`)
    } finally { undoRedoBusy = false }
  }

  // ─── State ────────────────────────────────────────────────────────────────

  let appState: AppState       = $state('welcome')
  let project:  Project | null = $state(null)
  let error:    string | null  = $state(null)
  let selectedStarter: string = $state('')
  let newName:  string         = $state('')
  let newPath:  string         = $state('')
  let creating: boolean        = $state(false)

  // Tree UI state
  let selectedId:  string | null = $state(null)
  let selectedIds: Set<string> = $state(new Set())
  let selectionRecency: string[] = $state([])
  let selectionAnchorId: string | null = $state(null)
  // When the user has a ghost selected in compare mode and leaves compare mode
  // (closing the snapshot pair), the ghost id can't survive in `selectedId`
  // because nothing in the live project resolves it. We stash it here so the
  // next time the same snapshot pair is compared, the selection is restored.
  // Cleared whenever the user makes a fresh live selection (issue #3).
  let stashedGhostSelection: string | null = $state(null)
  let expandedIds: Set<string>   = $state(new Set())
  let searchQuery: string        = $state('')
  let searchResults: SearchResult[] = $state([])
  let searchFilters: InventoryFilters = $state({})
  let inventoryFiltersOpen = $state(false)
  let inventoryViewMode: 'tree' | 'table' = $state('tree')
  let inventoryColumns = $state<InventoryColumn[]>([...DEFAULT_INVENTORY_COLUMNS])
  let inventorySortColumn = $state<InventoryColumn>('name')
  let inventorySortDirection = $state<InventorySortDirection>('asc')
  let searchTotal: number = $state(0)
  let searchHasMore: boolean = $state(false)
  let searchResultIndex: number = $state(0)
  let searching:   boolean       = $state(false)
  let searchLoadingMore: boolean = $state(false)
  let selectedScrollAlign: 'auto' | 'center' = $state('auto')
  let searchInputEl: HTMLInputElement | null = $state(null)

  const inventoryFiltersActive = $derived(hasInventoryFilters(searchFilters))
  const inventoryFilterCount = $derived(countInventoryFilters(searchFilters))
  const searchActive = $derived(searchQuery.trim().length > 0 || inventoryFiltersActive)
  const searchMatchSet = $derived(new Set(searchResults.map(r => r.nodeId)))
  const searchResultMap = $derived(new Map(searchResults.map(r => [r.nodeId, r])))
  const searchIncludeIds = $derived.by(() => {
    if (!project || !searchActive || searching) return null
    return searchRevealIds(project.nodes, searchResults)
  })

  // Inline add-child state
  let addingChildTo: string | null = $state(null)
  let addingChildName: string      = $state('')
  let addingChildError: string | null = $state(null)
  let addingChildTemplateId: string | null = $state(null)
  let addChildInput: HTMLInputElement | null = $state(null)
  // Only structurally-usable templates are offered in the node-create picker.
  const addChildTemplateIds = $derived.by<string[]>(() => {
    const p: Project | null = project
    const map = p?.templates ?? {}
    return Object.keys(map).filter(id => isUsableTemplate(map[id])).sort()
  })

  // Rename request signal — bumping this counter triggers DetailPane.startEditName().
  // Tree raises onRenameRequest → App increments → DetailPane $effect picks it up.
  let renameRequestId = $state(0)

  let moveToNodeId: string | null = $state(null)
  let batchDialogOpen = $state(false)

  // Snapshot/history UI state
  let snapshotPanelOpen: boolean = $state(false)
  let snapshots: Snapshot[] = $state([])
  let snapshotTimelineEvents: SnapshotTimelineEvent[] = $state([])
  let snapshotRecoveryPoints: RecoveryPoint[] = $state([])
  let snapshotLoading: boolean = $state(false)
  let snapshotCreating: boolean = $state(false)
  let snapshotComparing: boolean = $state(false)
  let snapshotRestoringName: string | null = $state(null)
  let snapshotError: string | null = $state(null)
  let snapshotErrorCode: string | null = $state(null)
  let revertDialogSnapshotName: string | null = $state(null)
  let revertDialogNoteRequired: boolean = $state(false)
  let revertDialogError: string | null = $state(null)
  let recoveryDialogPoint: RecoveryPoint | null = $state(null)
  let recoveryApplyingId: string | null = $state(null)
  let recoveryDialogError: string | null = $state(null)
  let workingCopyBaseSnapshot: string | null = $state(null)
  let workingCopyDirty: boolean = $state(false)

  // Compare mode state — separate from normal expanded state so user's tree
  // position is preserved when exiting compare mode.
  let compareMode: boolean = $state(false)
  let mergedTree: MergedTree | null = $state(null)
  let compareExpanded: Set<string> = $state(new Set())

  // Resizable pane widths (px).
  let treeWidth:  number = $state(DEFAULT_TREE_WIDTH)
  // The left pane's width in Table view, kept apart from treeWidth so a wide
  // table doesn't make the tree wide when switching back.
  let tableWidth: number = $state(DEFAULT_TABLE_WIDTH)
  let panelWidth: number = $state(DEFAULT_PANEL_WIDTH)
  let workspaceSettingsLoaded: boolean = $state(false)
  let unsubscribeWindowFocus: (() => void) | null = null
  let unsubscribeLayoutReset: (() => void) | null = null
  let lastCreateDirectory: string | null = $state(null)
  let lastWorkspaceProject: WorkspaceSettings['lastProject'] = $state(null)
  let recentProjects: RecentProject[] = $state([])

  // foldIds the user has manually expanded inside the Space-Folding Lens.
  // Resets on project close / mode flip — handled in those flows below.
  let lensExpandedFolds: Set<string> = $state(new Set())

  // Drag-to-resize state.
  let draggingHandle: PaneHandle | null = $state(null)
  let dragStartX = 0
  let dragStartWidth = 0

  // Which width the left pane shows and its resize handle drags. Compare mode
  // always shows the tree.
  const leftPaneHandle = $derived.by<PaneHandle>(() => inventoryViewMode === 'table' && !compareMode ? 'table' : 'tree')

  function startDrag(handle: PaneHandle, e: MouseEvent) {
    draggingHandle = handle
    dragStartX = e.clientX
    dragStartWidth = handle === 'tree' ? treeWidth : handle === 'table' ? tableWidth : panelWidth
    e.preventDefault()
  }

  function onDragMove(e: MouseEvent) {
    if (!draggingHandle) return
    const width = dragPaneWidth(draggingHandle, dragStartWidth, e.clientX - dragStartX)
    if (draggingHandle === 'tree') treeWidth = width
    else if (draggingHandle === 'table') tableWidth = width
    else panelWidth = width
  }

  function onDragEnd() {
    draggingHandle = null
  }

  // Non-blocking error toast
  let toastMsg:     string | null = $state(null)
  let toastTimer:   ReturnType<typeof setTimeout> | null = null
  let unsubscribeMenuCommands: (() => void) | null = null
  let unsubscribeProjectOpenFromOs: (() => void) | null = null
  const brandMark = './statekeep-mark.svg'
  const desktopChrome = window.api.platform

  // ─── Derived ──────────────────────────────────────────────────────────────

  const tree = $derived.by(() => {
    if (!project) return null
    return buildTree(project.nodes)
  })

  // Subtree change summaries for the lens — populated only in compare mode,
  // so the FoldMarker can show "47 unchanged · 3 added, 2 moved" rollups
  // for collapsed subtrees inside a fold. Pure derivation from mergedTree.
  const compareSubtreeSummaries = $derived.by(() =>
    mergedTree ? computeSubtreeSummaries(mergedTree) : null
  )

  const flatRows = $derived.by(() => {
    if (compareMode && mergedTree) {
      const mergedTreeBuilt = buildTree(mergedTree.nodes)
      if (!mergedTreeBuilt) return []
      return flattenTree(mergedTreeBuilt, compareExpanded, { compareMode: true })
    }
    if (!tree) return []
    return flattenTree(tree, expandedIds, searchIncludeIds ? { includeIds: searchIncludeIds } : {})
  })

  const selectedNode = $derived.by(() => {
    if (!selectedId || !project) return null
    if (compareMode && mergedTree) {
      return mergedTree.nodes.find((node) => node.id === selectedId) ?? null
    }
    return project.nodes.find((node) => node.id === selectedId) ?? null
  })

  const selectedNodes = $derived.by(() =>
    project ? project.nodes.filter(node => selectedIds.has(node.id)) : []
  )

  const detailProject = $derived.by(() => {
    if (!project) return null
    if (compareMode && mergedTree) {
      // Resolve the inspected node's typed fields against the side it belongs
      // to (ghost → from-snapshot templates, live → to-snapshot templates), so
      // a node bound to a template whose schema changed between the two
      // snapshots isn't mislabeled by the inspector. See templatesForNode.
      const templates = templatesForNode(selectedNode, mergedTree)
      return { ...project, nodes: mergedTree.nodes, templates }
    }
    return project
  })

  // The loaded comparison's snapshot pair, or null outside compare mode.
  const compareLabels = $derived<CompareLabels | null>(compareMode && mergedTree ? mergedTree : null)

  const projectModeLabel = $derived(formatProjectMode(compareLabels, workingCopyBaseSnapshot, workingCopyDirty))

  // Tree edits are locked while comparing, reverting, or applying a recovery
  // point; see lib/project-status for why.
  const editLock = $derived<EditLockState>({
    interruptedHistory,
    externalDocumentConflict,
    undoRedoBusy,
    snapshotCreating,
    compareMode,
    snapshotRestoringName,
    recoveryApplyingId,
  })
  const editingLocked = $derived(isEditingLocked(editLock))

  function lockReason(): string {
    return editLockReason(editLock)
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  function applyWindowFocus(isFocused: boolean) {
    document.documentElement.dataset.windowFocused = String(isFocused)
  }

  onMount(async () => {
    window.addEventListener('keydown', handleEditKeydown, true)
    document.addEventListener('focusin', updateEditFocus)
    document.addEventListener('focusout', updateEditFocus)
    unsubscribeMenuCommands = window.api.menu.onCommand((command) => {
      void runMenuCommand(command)
    })
    unsubscribeProjectOpenFromOs = window.api.project.onOpenedFromOs((result) => {
      handleProjectOpenedFromOs(result)
    })
    unsubscribeWindowFocus = window.api.windowState.onFocusChanged(applyWindowFocus)
    unsubscribeLayoutReset = window.api.settings.onLayoutReset((settings) => {
      applyWorkspaceSettings(settings)
    })
    const focusState = await window.api.windowState.isFocused()
    if (focusState.ok) applyWindowFocus(focusState.data)

    const settings = await window.api.settings.get()
    if (settings.ok) {
      applyWorkspaceSettings(settings.data)
    } else {
      lastSentWorkspaceSettings = serializeWorkspacePaneSettings({ treeWidth, tableWidth, panelWidth })
    }
    workspaceSettingsLoaded = true

    await refreshRecentProjects()

    // Rehydrate if main already has a project open (e.g. macOS activate).
    const result = await window.api.project.getCurrent()
    if (result.ok && result.data) {
      project = result.data
      selectRoot(result.data)
      appState = 'open'
    }

    // Resize drag — registered once here, cleaned up in onDestroy.
    window.addEventListener('mousemove', onDragMove)
    window.addEventListener('mouseup', onDragEnd)
  })

  onDestroy(() => {
    window.removeEventListener('keydown', handleEditKeydown, true)
    document.removeEventListener('focusin', updateEditFocus)
    document.removeEventListener('focusout', updateEditFocus)
    unsubscribeMenuCommands?.()
    unsubscribeMenuCommands = null
    unsubscribeProjectOpenFromOs?.()
    unsubscribeProjectOpenFromOs = null
    unsubscribeWindowFocus?.()
    unsubscribeWindowFocus = null
    unsubscribeLayoutReset?.()
    unsubscribeLayoutReset = null
    clearWorkspaceSettingsSaveTimer()
    delete document.documentElement.dataset.windowFocused
    window.removeEventListener('mousemove', onDragMove)
    window.removeEventListener('mouseup', onDragEnd)
  })

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function selectRoot(p: Project) {
    const root = p.nodes.find(n => n.parentId === null)
    if (root) {
      setSelection(root.id)
      expandedIds = new Set([root.id])
    }
  }

  function showToast(msg: string) {
    toastMsg = msg
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toastMsg = null }, 4000)
  }

  // Export the loaded compare as a saved report. Main builds + writes (renderer
  // never touches the filesystem); a canceled save dialog is a silent no-op.
  async function handleExportReport(format: ReportFormat) {
    if (!mergedTree) return
    const res = await window.api.report.export(
      mergedTree.fromSnapshot,
      mergedTree.toSnapshot,
      format,
      mergedTree.scope?.nodeId ?? null,
    )
    if (!res.ok) { showToast(`Export failed: ${res.error.message}`); return }
    if (res.data.savedPath) showToast(`Report saved to ${res.data.savedPath}`)
  }

  // Copy the loaded compare as Markdown. Clipboard is a renderer-side write, not
  // a filesystem touch, so it stays in the renderer.
  async function handleCopyReport() {
    if (!mergedTree) return
    const res = await window.api.report.build(
      mergedTree.fromSnapshot,
      mergedTree.toSnapshot,
      'markdown',
      mergedTree.scope?.nodeId ?? null,
    )
    if (!res.ok) { showToast(`Copy failed: ${res.error.message}`); return }
    try {
      await navigator.clipboard.writeText(res.data.content)
      showToast('Report copied to clipboard')
    } catch {
      showToast('Could not access the clipboard')
    }
  }

  async function focusInput(el: HTMLInputElement | null) {
    await tick()
    el?.focus()
    el?.select()
  }

  $effect(() => {
    if (addingChildTo) {
      void focusInput(addChildInput)
    }
  })

  function applyProject(p: Project) {
    project = p
    // Search results are computed against the previous project; once the
    // project mutates, stale match ids can point at deleted or moved nodes.
    if (searchActive) clearSearch()
    // If selected node was deleted, fall back to root.
    // Ghost selections (issue #3) live in mergedTree.nodes, not project.nodes,
    // so don't clobber them just because the live project mutated.
    const isGhostSelection = selectedId?.startsWith('ghost:') ?? false
    if (!isGhostSelection) {
      applySelection(pruneSelection(currentSelection(), new Set(p.nodes.map(node => node.id))))
    }
    if (selectedId && !isGhostSelection && !p.nodes.find(n => n.id === selectedId)) {
      const root = p.nodes.find(n => n.parentId === null)
      setSelection(root?.id ?? null)
    }
  }

  function markWorkingCopyChanged() {
    workingCopyDirty = true
  }

  async function reloadCurrentProject() {
    const result = await window.api.project.getCurrent()
    if (result.ok && result.data) {
      applyProject(result.data)
    }
  }

  function handleProjectOpenedFromOs(result: Awaited<ReturnType<typeof window.api.project.open>>) {
    if (!result.ok) {
      error = result.error.message
      showToast(result.error.message)
      return
    }

    resetOpenProjectUi()
    applyOpenedProject(result.data)
    error = null
  }

  function resetOpenProjectUi() {
    clearSearch()
    snapshotPanelOpen = false
    snapshots = []
    snapshotTimelineEvents = []
    snapshotRecoveryPoints = []
    snapshotError = null
    snapshotLoading = false
    snapshotCreating = false
    snapshotComparing = false
    snapshotRestoringName = null
    revertDialogSnapshotName = null
    revertDialogNoteRequired = false
    revertDialogError = null
    recoveryDialogPoint = null
    recoveryDialogError = null
    recoveryApplyingId = null
    workingCopyBaseSnapshot = null
    workingCopyDirty = false
    compareMode = false
    mergedTree = null
    compareExpanded = new Set()
    lensExpandedFolds = new Set()
    importDialogOpen = false
    importBaseParent = null
    importSummary = null
    importSummaryDismissed = false
    templateManagerOpen = false
    duplicateNodeId = null
    batchDialogOpen = false
    moveToNodeId = null
    addingChildTo = null
    addingChildName = ''
    addingChildError = null
    addingChildTemplateId = null
    stashedGhostSelection = null
  }

  function beginCreateProject() {
    if (project) {
      showToast('Close the current project before creating a new project.')
      return
    }
    selectedStarter = ''
    newPath = lastCreateDirectory ?? ''
    appState = 'creating'
    error = null
  }

  async function saveCurrentProject() {
    if (!project) return
    const result = await window.api.project.save()
    if (result.ok) showToast('Project saved')
    else showToast(result.error.message)
  }

  async function focusSearch() {
    if (!project || compareMode) return
    await tick()
    searchInputEl?.focus()
    searchInputEl?.select()
  }

  async function reindexHistory() {
    if (!project) return
    const result = await window.api.node.historyReindex()
    if (result.ok) showToast('History index refreshed')
    else showToast(result.error.message)
  }

  function buildMenuCommandState(): MenuCommandState {
    return buildMenuCommandStateFor(commandContext)
  }

  function canRunMenuCommand(command: MenuCommandId): boolean {
    return buildMenuCommandState()[command]
  }

  async function runMenuCommand(command: MenuCommandId) {
    if (command === 'project:undo' || command === 'project:redo') {
      const direction = command === 'project:undo' ? 'undo' : 'redo'
      if (isTextEditing(document.activeElement)) await window.api.text.undoRedo(direction)
      else await applyUndoRedo(direction)
      return
    }
    if (!canRunMenuCommand(command)) return

    switch (command) {
      case 'project:new':
        beginCreateProject()
        return
      case 'project:open':
        await openProject()
        return
      case 'project:save':
        await saveCurrentProject()
        return
      case 'project:close':
        await closeProject()
        return
      case 'project:import':
        openImportDialog()
        return
      case 'project:templates':
        openTemplateManager()
        return
      case 'project:snapshots':
        await toggleSnapshots()
        return
      case 'project:search':
        await focusSearch()
        return
      case 'compare:exit':
        exitCompareMode()
        return
      case 'report:copyMarkdown':
        await handleCopyReport()
        return
      case 'report:exportMarkdown':
        await handleExportReport('markdown')
        return
      case 'report:exportCsv':
        await handleExportReport('csv')
        return
      case 'report:exportHtml':
        await handleExportReport('html')
        return
      case 'node:addChild':
        if (selectedNode && !selectedId?.startsWith('ghost:')) handleAddChild(selectedNode.id)
        return
      case 'node:addSibling':
        if (selectedNode?.parentId) handleAddChild(selectedNode.parentId)
        return
      case 'node:moveUp':
        if (selectedNode) await handleMoveUp(selectedNode.id)
        return
      case 'node:moveDown':
        if (selectedNode) await handleMoveDown(selectedNode.id)
        return
      case 'snapshot:create':
      case 'compare:start':
        exitCompareMode()
        await openSnapshots()
        await tick()
        document.querySelector<HTMLElement>(command === 'snapshot:create' ? '[data-testid="snapshot-name-input"]' : '[data-testid="compare-from-select"]')?.focus()
        return
      case 'node:rename':
        handleRenameRequest()
        return
      case 'node:duplicate':
        if (selectedNode) handleDuplicate(selectedNode.id)
        return
      case 'node:moveTo':
        if (selectedNode && !selectedId?.startsWith('ghost:')) handleMoveTo(selectedNode.id)
        return
      case 'node:delete':
        if (selectedNode && !selectedId?.startsWith('ghost:')) await handleDelete(selectedNode.id)
        return
      case 'history:reindex':
        await reindexHistory()
        return
    }
  }

  // Push enabled/disabled state to the native menu, but only when it actually
  // changes — the effect re-runs on every reactive dependency, and most UI
  // interactions leave the command map identical. Skipping no-op sends avoids a
  // high volume of redundant IPC messages and native menu mutations.
  let lastSentMenuState = ''
  $effect(() => {
    const next = buildMenuCommandState()
    const serialized = JSON.stringify(next)
    if (serialized === lastSentMenuState) return
    lastSentMenuState = serialized
    window.api.menu.updateState(next)
  })

  let lastSentWorkspaceSettings = ''
  let workspaceSettingsSaveTimer: ReturnType<typeof setTimeout> | null = null
  $effect(() => {
    if (!workspaceSettingsLoaded) return
    const serialized = serializeWorkspacePaneSettings({ treeWidth, tableWidth, panelWidth })
    if (serialized === lastSentWorkspaceSettings) {
      clearWorkspaceSettingsSaveTimer()
      return
    }
    clearWorkspaceSettingsSaveTimer()
    workspaceSettingsSaveTimer = setTimeout(() => {
      workspaceSettingsSaveTimer = null
      const next = roundPaneWidths({ treeWidth, tableWidth, panelWidth })
      const nextSerialized = serializeWorkspacePaneSettings(next)
      if (nextSerialized === lastSentWorkspaceSettings) return
      lastSentWorkspaceSettings = nextSerialized
      void window.api.settings.updateWorkspace(next)
    }, WORKSPACE_SETTINGS_SAVE_DELAY_MS)
  })

  // ─── Welcome actions ──────────────────────────────────────────────────────

  async function refreshRecentProjects() {
    const result = await window.api.recentProjects.list()
    if (result.ok) recentProjects = result.data
  }

  async function openProject() {
    error = null
    const folderPath = await window.api.dialog.openFolder('Open Project', 'open-project')
    if (!folderPath) return

    const fallbackState = project ? 'open' : 'welcome'
    if (project) {
      const saved = await window.api.project.save()
      if (!saved.ok) {
        error = saved.error.message
        showToast(saved.error.message)
        return
      }
    }

    appState = 'loading'
    const result = await window.api.project.open(folderPath)
    if (result.ok) {
      resetOpenProjectUi()
      applyOpenedProject(result.data)
    } else {
      error = result.error.message
      appState = fallbackState
    }
  }

  function acceptFileDrag(event: DragEvent) {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
  }

  async function handleFileDrop(event: DragEvent) {
    event.preventDefault()
    if (appState === 'loading' || creating || importDialogOpen || templateManagerOpen || archiveOpen || duplicateNodeId || moveToNodeId || batchDialogOpen || revertDialogSnapshotName || recoveryDialogPoint) {
      showToast('Finish the current operation before dropping a file.')
      return
    }
    const files = event.dataTransfer?.files
    if (!files || files.length !== 1) { showToast('Drop one project, CSV, or NetBox JSON file at a time.'); return }
    let path: string
    try { path = window.api.files.pathForFile(files[0]!) } catch { showToast('This file could not be read. Use Open Project or Import instead.'); return }
    if (!path) { showToast('Drop a file from your computer.'); return }
    if (/\.(csv|json)$/i.test(path)) {
      if (!project) { showToast('Open a project before importing a CSV or NetBox JSON file.'); return }
      if (editingLocked) { showToast(lockReason()); return }
      openImportDialog()
      droppedImportPath = path
      return
    }
    if (!/\.statekeep$/i.test(path)) { showToast('Unsupported file. Drop a .statekeep project, CSV, or NetBox JSON file.'); return }
    const fallbackState = project ? 'open' : 'welcome'
    if (project) {
      const saved = await window.api.project.save()
      if (!saved.ok) { showToast(saved.error.message); return }
    }
    appState = 'loading'
    const result = await window.api.project.open(path)
    if (result.ok) { resetOpenProjectUi(); applyOpenedProject(result.data) }
    else { appState = fallbackState; showToast(result.error.message) }
  }

  async function openExampleProject() {
    error = null
    const fallbackState = project ? 'open' : 'welcome'
    appState = 'loading'
    const result = await window.api.project.openExample()
    if (result.ok) {
      resetOpenProjectUi()
      applyOpenedProject(result.data)
    } else {
      error = result.error.message
      appState = fallbackState
    }
  }

  async function openRecentProject(recentProject: RecentProject) {
    if (!recentProject.exists) return
    error = null
    appState = 'loading'
    const result = await window.api.project.open(recentProject.path)
    if (result.ok) {
      resetOpenProjectUi()
      applyOpenedProject(result.data)
    } else {
      error = result.error.message
      appState = 'welcome'
      recentProjects = recentProjects.map(entry =>
        entry.path === recentProject.path ? { ...entry, exists: false } : entry
      )
    }
  }

  async function selectFolder() {
    const folderPath = await window.api.dialog.openFolder('Choose Location', 'create-project')
    if (folderPath) {
      newPath = folderPath
      lastCreateDirectory = folderPath
    }
  }

  async function createProject() {
    if (!newName.trim() || !newPath) return
    creating = true
    error = null
    const result = selectedStarter
      ? await window.api.project.createStarter(selectedStarter, newName.trim(), newPath)
      : await window.api.project.create(newName.trim(), newPath)
    creating = false
    if (result.ok) {
      applyOpenedProject(result.data)
    } else {
      error = result.error.message
      if (result.error.context?.starterProjectPath) {
        const partial = await window.api.project.getCurrent()
        if (partial.ok && partial.data?.path === result.error.context.starterProjectPath) {
          applyOpenedProject(partial.data)
          showToast(result.error.message)
        }
      }
    }
  }

  async function closeProject() {
    const result = await window.api.project.close()
    if (!result.ok) {
      error = result.error.message
      showToast(result.error.message)
      return
    }
    project = null
    setSelection(null)
    expandedIds = new Set()
    clearSearch()
    appState = 'welcome'
    newName = ''
    newPath = ''
    error = null
    snapshotPanelOpen = false
    snapshots = []
    snapshotError = null
    workingCopyBaseSnapshot = null
    workingCopyDirty = false
    compareMode = false
    mergedTree = null
    compareExpanded = new Set()
    lensExpandedFolds = new Set()
    // stashedGhostSelection already cleared by setSelection(null) above.
  }

  function applyOpenedProject(openedProject: Project) {
    project = openedProject
    selectRoot(openedProject)
    workingCopyBaseSnapshot = null
    workingCopyDirty = false
    loadWarningsDismissed = false
    projectWarningsDismissed = false
    appState = 'open'
    if (openedProject.path) {
      lastWorkspaceProject = {
        path: openedProject.path,
        name: openedProject.name,
        exists: true,
      }
    }
    void refreshRecentProjects()
  }

  function applyWorkspaceSettings(settings: WorkspaceSettings) {
    treeWidth = settings.treeWidth
    tableWidth = settings.tableWidth
    panelWidth = settings.panelWidth
    lastSentWorkspaceSettings = serializeWorkspacePaneSettings(settings)
    lastCreateDirectory = settings.lastCreateDirectory
    lastWorkspaceProject = settings.lastProject
  }

  function clearWorkspaceSettingsSaveTimer() {
    if (!workspaceSettingsSaveTimer) return
    clearTimeout(workspaceSettingsSaveTimer)
    workspaceSettingsSaveTimer = null
  }

  // ─── Tree actions ─────────────────────────────────────────────────────────

  /**
   * Single entry point for changing `selectedId`. Always invalidates any
   * stashed ghost selection (issue #3): an explicit selection — whether
   * triggered by tree click, search, add-child, or diff-row navigation —
   * means the user has moved on, so don't surprise them by restoring a
   * stale ghost the next time compare mode is re-entered.
   *
   * Inside compare mode the stash is already null (handleSnapshotCompare
   * consumes it on entry), so the clear is a no-op there.
   */
  function setSelection(id: string | null): void {
    applySelection(singleSelection(id))
    stashedGhostSelection = null
  }

  function currentSelection(): SelectionState {
    return { selectedId, selectedIds, selectionRecency, selectionAnchorId }
  }

  /**
   * Assign a selection without touching stashedGhostSelection. Compare-mode
   * entry and exit use this directly because they manage the stash themselves.
   */
  function applySelection(next: SelectionState): void {
    selectedId = next.selectedId
    selectedIds = next.selectedIds
    selectionRecency = next.selectionRecency
    selectionAnchorId = next.selectionAnchorId
  }

  function handleSelect(id: string, modifiers?: { toggle: boolean; range: boolean }) {
    selectedScrollAlign = 'auto'
    applySelection(selectWithModifiers(currentSelection(), id, modifiers, () => flatRows, compareMode))
    stashedGhostSelection = null
    addingChildTo = null
  }

  function handleToggle(id: string) {
    if (compareMode) {
      const next = new Set(compareExpanded)
      if (next.has(id)) { next.delete(id) } else { next.add(id) }
      compareExpanded = next
    } else {
      const next = new Set(expandedIds)
      if (next.has(id)) { next.delete(id) } else { next.add(id) }
      expandedIds = next
    }
  }

  function handleAddChild(parentId: string) {
    if (editingLocked) {
      showToast(lockReason())
      return
    }
    addingChildTo = parentId
    addingChildName = ''
    addingChildError = null
    addingChildTemplateId = null
    expandedIds = new Set([...expandedIds, parentId])
  }

  async function commitAddChild() {
    if (editingLocked) {
      showToast(lockReason())
      return
    }
    if (!addingChildTo || !addingChildName.trim()) {
      addingChildError = 'Name is required'
      return
    }
    const result = await window.api.node.create(
      addingChildTo,
      addingChildName.trim(),
      addingChildTemplateId,
    )
    if (result.ok) {
      applyProject(result.data)
      markWorkingCopyChanged()
      // Select the new node (last child of parent).
      const newNode = result.data.nodes
        .filter(n => n.parentId === addingChildTo)
        .sort((a, b) => b.order - a.order)[0]
      if (newNode) setSelection(newNode.id)
      addingChildTo = null
      addingChildName = ''
      addingChildTemplateId = null
    } else {
      addingChildError = result.error.message
    }
  }

  function cancelAddChild() {
    addingChildTo = null
    addingChildName = ''
    addingChildError = null
    addingChildTemplateId = null
  }

  async function handleMoveUp(id: string) {
    if (!project || editingLocked) return
    const idx = getSiblingIndex(id, project.nodes)
    if (idx <= 0) return
    const result = await window.api.node.move(id, project.nodes.find(n => n.id === id)!.parentId!, idx - 1)
    if (result.ok) {
      applyProject(result.data)
      markWorkingCopyChanged()
    }
    else showToast(result.error.message)
  }

  async function handleMoveDown(id: string) {
    if (!project || editingLocked) return
    const node = project.nodes.find(n => n.id === id)
    if (!node) return
    const siblings = project.nodes.filter(n => n.parentId === node.parentId)
    const idx = getSiblingIndex(id, project.nodes)
    if (idx >= siblings.length - 1) return
    const result = await window.api.node.move(id, node.parentId!, idx + 1)
    if (result.ok) {
      applyProject(result.data)
      markWorkingCopyChanged()
    }
    else showToast(result.error.message)
  }

  function handleDuplicate(id: string) {
    if (!project || editingLocked || duplicateNodeId) return
    const source = project.nodes.find(node => node.id === id)
    if (source?.parentId) duplicateNodeId = id
  }

  async function confirmDuplicate(name: string): Promise<string | null> {
    const source = duplicateNode
    if (!project || !source || editingLocked) return 'The source node is no longer available.'
    const originalIds = new Set(project.nodes.map(node => node.id))
    const result = await window.api.node.duplicate(source.id, name)
    if (!result.ok) return result.error.message
    applyProject(result.data)
    markWorkingCopyChanged()
    duplicateNodeId = null
    const copy = result.data.nodes.find(node => !originalIds.has(node.id) && node.parentId === source.parentId)
    if (copy) {
      expandedIds = expandToReveal(expandedIds, copy.id, result.data.nodes)
      setSelection(copy.id)
      selectedScrollAlign = 'center'
    }
    return null
  }

  function openBatchPropertyDialog() {
    if (editingLocked || selectedNodes.length < 2) return
    batchDialogOpen = true
  }

  async function confirmBatchPropertyUpdate(request: BatchPropertyUpdateRequest): Promise<string | null> {
    if (!project || editingLocked || selectedNodes.length < 2) return 'The selection is no longer available.'
    const result = await window.api.node.batchUpdateProperties(request)
    if (!result.ok) return result.error.message
    applyProject(result.data.project)
    markWorkingCopyChanged()
    batchDialogOpen = false
    showToast(`Updated ${result.data.changesApplied} selected node${result.data.changesApplied === 1 ? '' : 's'}`)
    return null
  }

  function handleMoveTo(id: string) {
    if (editingLocked) {
      showToast(lockReason())
      return
    }
    moveToNodeId = id
  }

  async function confirmMoveTo(targetParentId: string) {
    if (!moveToNodeId || editingLocked) return
    const result = await window.api.node.move(moveToNodeId, targetParentId, 999)
    moveToNodeId = null
    if (result.ok) {
      applyProject(result.data)
      markWorkingCopyChanged()
    }
    else showToast(result.error.message)
  }

  async function handleDelete(id: string) {
    if (!project || editingLocked) return
    const node = project.nodes.find(n => n.id === id)
    if (!node) return

    const descendantCount = getDescendantIds(id, project.nodes).length

    if (descendantCount > 0) {
      const confirmed = window.confirm(deleteSubtreeConfirmMessage(node.name, descendantCount))
      if (!confirmed) return
    }

    const result = await window.api.node.delete(id)
    if (result.ok) {
      applyProject(result.data)
      markWorkingCopyChanged()
      return
    }

    // Blocked by incoming references? Offer to clear them and force the delete.
    const blockers = referenceBlockersFromContext(result.error.context)
    if (blockers.length > 0) {
      const confirmed = window.confirm(referenceBlockersConfirmMessage(node.name, blockers))
      if (!confirmed) return
      const forced = await window.api.node.delete(id, { unlinkReferences: true })
      if (forced.ok) {
        applyProject(forced.data)
        markWorkingCopyChanged()
      }
      else showToast(forced.error.message)
      return
    }

    showToast(result.error.message)
  }

  function handleRenameRequest() {
    if (editingLocked) {
      showToast(lockReason())
      return
    }
    // Bump the signal counter — DetailPane's $effect will call startEditName().
    renameRequestId += 1
  }

  async function handleNodeUpdate(
    id: string,
    changes: {
      name?: string
      properties?: Record<string, string | number | boolean | null>
      templateId?: string | null
    }
  ) {
    if (editingLocked) {
      showToast(lockReason())
      return
    }
    const result = await window.api.node.update(id, changes)
    if (result.ok) {
      applyProject(result.data)
      markWorkingCopyChanged()
    }
    else showToast(result.error.message)
  }

  // Promote an ad-hoc property to a typed field on the node's template.
  async function handlePromoteField(nodeId: string, key: string, type: PropertyType) {
    if (!project || editingLocked) { showToast(lockReason()); return }
    const node = project.nodes.find(n => n.id === nodeId)
    const templateId = node?.templateId ?? null
    if (!templateId) { showToast('Assign a template before promoting a property.'); return }
    const template = project.templates?.[templateId]
    if (!template) { showToast('Template not found.'); return }

    // $state.snapshot: template.fields is a deep Svelte proxy; nested field
    // objects must be plain to survive structured-clone across the IPC boundary.
    const existingFields = $state.snapshot(template.fields) as Record<string, NodeTemplate['fields'][string]>
    const nextFields = { ...existingFields, [key]: { type } }
    const result = await window.api.template.update(templateId, { fields: nextFields })
    if (result.ok) {
      applyProject(result.data)
      markWorkingCopyChanged()
    } else {
      showToast(result.error.message)
    }
  }

  // ─── Templates ──────────────────────────────────────────────────────────────

  let templateManagerOpen = $state(false)

  // Load-time warnings (typed-value/integrity issues found when opening a
  // hand-edited document). Delivered once on open; cleared by any mutation.
  let loadWarningsDismissed = $state(false)
  const loadWarnings = $derived.by<DocumentWarning[]>(() => {
    const p: Project | null = project
    return p?.loadWarnings ?? []
  })
  const showLoadWarnings = $derived(loadWarnings.length > 0 && !loadWarningsDismissed)

  let projectWarningsDismissed = $state(false)
  const projectWarnings = $derived.by<ProjectWarning[]>(() => {
    const p: Project | null = project
    return p?.projectWarnings ?? []
  })
  const showProjectWarnings = $derived(projectWarnings.length > 0 && !projectWarningsDismissed)

  function openTemplateManager() {
    if (editingLocked) { showToast(lockReason()); return }
    templateManagerOpen = true
  }

  async function handleTemplateCreate(id: string, template: NodeTemplate): Promise<string | null> {
    const result = await window.api.template.create(id, template)
    if (result.ok) { applyProject(result.data); markWorkingCopyChanged(); return null }
    return result.error.message
  }

  async function handleTemplateUpdate(id: string, template: NodeTemplate): Promise<string | null> {
    const result = await window.api.template.update(id, template)
    if (result.ok) { applyProject(result.data); markWorkingCopyChanged(); return null }
    return result.error.message
  }

  async function handleTemplateDelete(id: string): Promise<string | null> {
    const result = await window.api.template.delete(id)
    if (result.ok) { applyProject(result.data); markWorkingCopyChanged(); return null }
    return result.error.message
  }

  // ─── CSV import ───────────────────────────────────────────────────────────────

  let droppedImportPath = $state<string | null>(null)
  let importDialogOpen = $state(false)
  let importBaseParent = $state<ProjectNode | null>(null)
  let importSummary = $state<ImportResult | null>(null)
  let importSummaryDismissed = $state(false)
  const showImportSummary = $derived(importSummary !== null && !importSummaryDismissed)

  function resolveBaseParent(node?: ProjectNode): ProjectNode | null {
    if (!project) return null
    if (node) return node
    const sel = selectedId ? project.nodes.find(n => n.id === selectedId) : undefined
    return sel ?? project.nodes.find(n => n.parentId === null) ?? null
  }

  function openImportDialog(node?: ProjectNode) {
    if (editingLocked) { showToast(lockReason()); return }
    const base = resolveBaseParent(node)
    if (!base) return
    droppedImportPath = null
    importBaseParent = base
    importDialogOpen = true
  }

  function handleImportHere(id: string) {
    const node = project?.nodes.find(n => n.id === id)
    openImportDialog(node)
  }

  function handleImported(next: Project, summary: ImportResult) {
    applyProject(next)
    markWorkingCopyChanged()
    // Reveal the imported rows by expanding the base parent (flat imports land
    // directly under it; path imports go deeper, but expanding the base is a
    // sensible starting point).
    if (importBaseParent) expandedIds = new Set([...expandedIds, importBaseParent.id])
    importSummary = summary
    importSummaryDismissed = false
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  let searchTimer: ReturnType<typeof setTimeout> | null = null
  let searchRequestId = 0
  const searchPageSize = 50

  function revealSearchResult(index = searchResultIndex): void {
    const result = searchResults[index]
    if (!result) return
    searchResultIndex = index
    selectedScrollAlign = 'center'
    setSelection(result.nodeId)
  }

  function cycleSearchResult(reverse: boolean): void {
    if (searchResults.length === 0) return
    if (!reverse && searchResultIndex === searchResults.length - 1 && searchHasMore) {
      void loadMoreSearchResults(true)
      return
    }
    const next = cycleIndex(searchResultIndex, searchResults.length, reverse)
    revealSearchResult(next)
  }

  function runSearch(query: string): void {
    if (searchTimer) clearTimeout(searchTimer)
    const requestId = ++searchRequestId
    if (!query.trim() && !hasInventoryFilters(searchFilters)) {
      searchResults = []
      searchTotal = 0
      searchHasMore = false
      searchResultIndex = 0
      searching = false
      searchLoadingMore = false
      return
    }
    searching = true
    searchLoadingMore = false
    searchResults = []
    searchTotal = 0
    searchHasMore = false
    searchResultIndex = 0
    const filters = { ...searchFilters }
    const filterSignature = JSON.stringify(filters)
    searchTimer = setTimeout(async () => {
      const result = await window.api.search.query(query, 0, searchPageSize, filters)
      if (
        requestId !== searchRequestId ||
        query !== searchQuery ||
        filterSignature !== JSON.stringify(searchFilters)
      ) return
      searching = false
      if (result.ok) {
        searchResults = result.data.results
        searchTotal = result.data.total
        searchHasMore = result.data.hasMore
        searchResultIndex = 0
        await tick()
        revealSearchResult(0)
      }
    }, 200)
  }

  async function loadMoreSearchResults(selectFirstNew = false): Promise<void> {
    if (searching || searchLoadingMore || !searchHasMore) return
    const query = searchQuery
    const requestId = searchRequestId
    const offset = searchResults.length
    const expectedTotal = searchTotal
    const filters = { ...searchFilters }
    const filterSignature = JSON.stringify(filters)
    searchLoadingMore = true
    try {
      const result = await window.api.search.query(query, offset, searchPageSize, filters)
      if (
        requestId !== searchRequestId ||
        query !== searchQuery ||
        filterSignature !== JSON.stringify(searchFilters)
      ) return
      if (!result.ok) {
        showToast(result.error.message)
        return
      }
      if (result.data.offset !== offset || result.data.total !== expectedTotal) {
        showToast('Search results changed and were refreshed.')
        runSearch(query)
        return
      }
      searchResults = [...searchResults, ...result.data.results]
      searchTotal = result.data.total
      searchHasMore = result.data.hasMore
      if (selectFirstNew && result.data.results.length > 0) {
        await tick()
        revealSearchResult(offset)
      }
    } finally {
      if (requestId === searchRequestId) searchLoadingMore = false
    }
  }

  function handleSearchInput(e: Event) {
    searchQuery = (e.target as HTMLInputElement).value
    runSearch(searchQuery)
  }

  function handleInventoryFiltersChange(filters: InventoryFilters): void {
    searchFilters = filters
    runSearch(searchQuery)
  }

  function handleSearchKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (!searchActive) return
      e.preventDefault()
      clearSearch()
      searchInputEl?.focus()
      return
    }
    if (e.key === 'Enter') {
      if (!searchActive) return
      e.preventDefault()
      cycleSearchResult(e.shiftKey)
    }
  }

  function handleSearchShortcutInput(ch: string) {
    if (compareMode) return
    searchQuery += ch
    searchInputEl?.focus()
    runSearch(searchQuery)
  }

  function clearSearch() {
    if (searchTimer) clearTimeout(searchTimer)
    searchRequestId++
    searchQuery = ''
    searchFilters = {}
    inventoryFiltersOpen = false
    searchResults = []
    searchTotal = 0
    searchHasMore = false
    searchResultIndex = 0
    searching = false
    searchLoadingMore = false
  }

  // ─── Snapshots / history ────────────────────────────────────────────────

  async function refreshSnapshots() {
    if (!project) return
    snapshotLoading = true
    snapshotError = null
    snapshotErrorCode = null

    const [result, timelineResult] = await Promise.all([
      window.api.snapshot.list(),
      window.api.snapshot.timeline(),
    ])
    snapshotLoading = false

    if (result.ok) {
      snapshots = result.data
    } else {
      snapshots = []
      snapshotError = result.error.message
      snapshotErrorCode = result.error.code
    }

    if (timelineResult.ok) {
      snapshotTimelineEvents = timelineResult.data.events
      snapshotRecoveryPoints = timelineResult.data.recoveryPoints
    } else {
      snapshotTimelineEvents = []
      snapshotRecoveryPoints = []
      snapshotError = timelineResult.error.message
      snapshotErrorCode = timelineResult.error.code
    }
  }

  async function openSnapshots() {
    snapshotPanelOpen = true
    await refreshSnapshots()
  }

  async function toggleSnapshots() {
    if (snapshotPanelOpen) {
      closeSnapshots()
      return
    }
    await openSnapshots()
  }

  function closeSnapshots() {
    snapshotPanelOpen = false
    snapshotError = null
    snapshotCreating = false
    snapshotComparing = false
    snapshotRestoringName = null
    exitCompareMode()
  }

  function exitCompareMode() {
    compareMode = false
    mergedTree = null
    compareExpanded = new Set()
    // If a ghost is selected, stash it so we can restore on re-entering
    // compare mode (issue #3). Then fall back to a live selection.
    //
    // NB: the assignments below intentionally bypass setSelection() — that
    // helper clears stashedGhostSelection, which would defeat the stash we
    // just set. The stash is consumed by handleSnapshotCompare on re-entry.
    if (selectedId?.startsWith('ghost:')) {
      stashedGhostSelection = selectedId
      const root = project?.nodes.find(node => node.parentId === null)
      applySelection(singleSelection(root?.id ?? null))
    } else if (project && selectedId && !project.nodes.find(node => node.id === selectedId)) {
      const root = project.nodes.find(node => node.parentId === null)
      applySelection(singleSelection(root?.id ?? null))
    }
  }

  async function handleSnapshotCreate(name: string, description: string | null): Promise<boolean> {
    snapshotCreating = true
    snapshotError = null
    const result = await window.api.snapshot.create(name, description)
    snapshotCreating = false

    if (result.ok) {
      workingCopyBaseSnapshot = result.data.name
      workingCopyDirty = false
      await refreshSnapshots()
      showToast(`Snapshot "${result.data.name}" created`)
      return true
    } else {
      snapshotError = result.error.message
      snapshotErrorCode = result.error.code
      return false
    }
  }

  async function handleSnapshotCompare(from: string, to: string, scopeNodeId: string | null) {
    snapshotComparing = true
    snapshotError = null
    const result = await window.api.snapshot.loadCompare(from, to, scopeNodeId)
    snapshotComparing = false

    if (result.ok) {
      mergedTree = result.data
      compareExpanded = seedCompareExpanded(expandedIds, result.data.nodes)
      compareMode = true
      // Compare mode is single-select: keep the primary, drop the rest.
      applySelection(singleSelection(selectedId))
      if (result.data.scope) {
        const scopedSelectionId = scopeSelectionId(result.data.scope.nodeId, result.data.nodes)
        applySelection(singleSelection(scopedSelectionId))
        compareExpanded = expandToReveal(compareExpanded, scopedSelectionId, result.data.nodes)
      }
      clearSearch()  // search is a browse-mode aid; don't carry it into compare

      // Restore a stashed ghost selection if this snapshot pair still
      // contains the same ghost id (issue #3). Otherwise drop the stash —
      // a different comparison shouldn't carry a stale ghost selection.
      //
      // NB: assigns selectedId directly (not via setSelection) because the
      // stash is explicitly cleared two lines below; routing through the
      // helper would clear it before the side effects below could run.
      if (stashedGhostSelection) {
        if (result.data.nodes.some(n => n.id === stashedGhostSelection)) {
          applySelection(singleSelection(stashedGhostSelection))
          // Expand ancestors so the restored ghost is visible.
          compareExpanded = expandToReveal(compareExpanded, stashedGhostSelection, result.data.nodes)
        }
        stashedGhostSelection = null
      }
    } else {
      snapshotError = result.error.message
      snapshotErrorCode = result.error.code
    }
  }

  /** Called when user clicks a diff row — selects that node in the tree. */
  function handleDiffNodeSelect(nodeId: string) {
    if (compareMode && mergedTree) {
      const compareSelectionId = resolveCompareSelectionId(nodeId, mergedTree.nodes)
      // Inside compare mode, the stash is already null (handleSnapshotCompare
      // consumed it on entry), so setSelection's clear is a defensive no-op.
      setSelection(compareSelectionId)
      compareExpanded = expandToReveal(compareExpanded, compareSelectionId, mergedTree.nodes)
    } else if (project) {
      setSelection(nodeId)
      expandedIds = expandToReveal(expandedIds, nodeId, project.nodes)
    }
  }

  async function handleSnapshotRestore(name: string) {
    revertDialogSnapshotName = name
    revertDialogNoteRequired = false
    revertDialogError = null
    snapshotError = null
  }

  async function confirmSnapshotRevert(note: string | null) {
    const name = revertDialogSnapshotName
    if (!name) return
    snapshotRestoringName = name
    snapshotError = null
    revertDialogError = null

    try {
      const result = await window.api.snapshot.revert({ name, note })

      if (!result.ok && result.error.code === 'VALIDATION_FAILED' && result.error.message.includes('revert note is required')) {
        snapshotRestoringName = null
        revertDialogNoteRequired = true
        revertDialogError = result.error.message
        return
      }

      snapshotRestoringName = null

      if (result.ok) {
        revertDialogSnapshotName = null
        revertDialogNoteRequired = false
        revertDialogError = null
        await reloadCurrentProject()
        await refreshSnapshots()
        exitCompareMode()
        workingCopyBaseSnapshot = name
        workingCopyDirty = false
        showToast(`Reverted current project to "${name}"`)
      } else {
        revertDialogError = result.error.message
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      snapshotRestoringName = null
      revertDialogError = `Failed to revert snapshot: ${message}`
    }
  }

  function cancelSnapshotRevert() {
    if (snapshotRestoringName) return
    revertDialogSnapshotName = null
    revertDialogNoteRequired = false
    revertDialogError = null
  }

  async function handleApplyRecovery(id: string) {
    const recoveryPoint = snapshotRecoveryPoints.find(point => point.id === id)
    if (!recoveryPoint) {
      snapshotError = `Recovery point not found: ${id}`
      snapshotErrorCode = null
      return
    }

    recoveryDialogPoint = recoveryPoint
    recoveryDialogError = null
    snapshotError = null
  }

  async function confirmRecoveryPointApply() {
    if (!recoveryDialogPoint) return

    recoveryApplyingId = recoveryDialogPoint.id
    recoveryDialogError = null
    snapshotError = null

    try {
      const result = await window.api.snapshot.applyRecovery({ id: recoveryDialogPoint.id })
      recoveryApplyingId = null

      if (result.ok) {
        recoveryDialogPoint = null
        recoveryDialogError = null
        await reloadCurrentProject()
        await refreshSnapshots()
        exitCompareMode()
        workingCopyBaseSnapshot = null
        workingCopyDirty = true
        showToast('Recovered current project from recovery point')
      } else {
        recoveryDialogError = result.error.message
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      recoveryApplyingId = null
      recoveryDialogError = `Failed to apply recovery point: ${message}`
    }
  }

  function cancelRecoveryPointApply() {
    if (recoveryApplyingId) return
    recoveryDialogPoint = null
    recoveryDialogError = null
  }
</script>

<!-- ─── Window drag region for macOS hidden titlebar ─────────────────────── -->
{#if desktopChrome.supportsWindowDragRegion}
  <div
    class="fixed top-0 left-0 right-0 h-8 [-webkit-app-region:drag] pointer-events-none z-50"
    data-testid="window-drag-region"
  ></div>
{/if}

<!-- ─── Toast ─────────────────────────────────────────────────────────────── -->
<div role="status" aria-live="polite" aria-atomic="true">
{#if toastMsg}
  <div class="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-red-700 text-white
              text-sm px-4 py-2 rounded-lg shadow-lg max-w-sm text-center"
       data-testid="toast">
    {toastMsg}
  </div>
{/if}
</div>


<!-- ─── Move-to dialog ────────────────────────────────────────────────────── -->
{#if duplicateNode && project}
  <DuplicateDialog node={duplicateNode} nodes={project.nodes} onConfirm={confirmDuplicate} onCancel={() => { duplicateNodeId = null }} />
{/if}

{#if batchDialogOpen && project && selectedNodes.length > 1}
  <BatchPropertyDialog
    {project}
    nodes={selectedNodes}
    onConfirm={confirmBatchPropertyUpdate}
    onCancel={() => { batchDialogOpen = false }}
  />
{/if}

{#if moveToNodeId && project}
  <MoveToDialog
    nodeId={moveToNodeId}
    nodes={project.nodes}
    onConfirm={confirmMoveTo}
    onCancel={() => { moveToNodeId = null }}
  />
{/if}

<!-- ─── Template manager ──────────────────────────────────────────────────── -->
{#if templateManagerOpen && project}
  <TemplateManager
    templates={project.templates ?? {}}
    onCreate={handleTemplateCreate}
    onUpdate={handleTemplateUpdate}
    onDelete={handleTemplateDelete}
    onClose={() => { templateManagerOpen = false }}
  />
{/if}

<svelte:window ondragover={acceptFileDrag} ondrop={handleFileDrop} />

<!-- ─── Import dialog ─────────────────────────────────────────────────────── -->
{#if importDialogOpen && project && importBaseParent}
  <ImportDialog
    initialPath={droppedImportPath}
    baseParent={importBaseParent}
    templates={project.templates ?? {}}
    onImported={handleImported}
    onClose={() => { importDialogOpen = false }}
  />
{/if}

<!-- ─── Welcome ────────────────────────────────────────────────────────────── -->
{#if archiveOpen}<ProjectArchive canExport={appState === 'open' && project !== null} onClose={() => { archiveOpen = false }} />{/if}
{#if appState === 'welcome'}
  <WelcomeScreen
    {brandMark}
    {error}
    {recentProjects}
    onOpenArchives={() => { archiveOpen = true }}
    onCreateProject={beginCreateProject}
    onOpenProject={openProject}
    onOpenRecent={openRecentProject}
    onOpenExample={openExampleProject}
  />

<!-- ─── Create project form ───────────────────────────────────────────────── -->
{:else if appState === 'creating'}
  <CreateProjectForm
    {brandMark}
    {error}
    bind:name={newName}
    bind:starterId={selectedStarter}
    path={newPath}
    {creating}
    onChooseFolder={selectFolder}
    onCancel={() => { appState = 'welcome'; error = null }}
    onCreate={createProject}
  />

<!-- ─── Loading ───────────────────────────────────────────────────────────── -->
{:else if appState === 'loading'}
  <div class="flex h-full items-center justify-center bg-stone-50">
    <p class="text-sm text-stone-400">Opening project…</p>
  </div>

<!-- ─── Project open ──────────────────────────────────────────────────────── -->
{:else if appState === 'open' && project}
  <div class="flex flex-col h-full bg-white" data-testid="project-view">

    <!-- Titlebar -->
    <ProjectTitlebar
      {brandMark}
      projectName={project.name}
      nodeCount={project.nodes.length}
      modeLabel={projectModeLabel}
      {compareMode}
      compareLoaded={compareMode && mergedTree !== null}
      reservesTrafficLightSpace={desktopChrome.reservesTrafficLightSpace}
      canUndo={canUndoProject}
      {editHistory}
      {snapshotPanelOpen}
      onOpenArchives={() => { archiveOpen = true }}
      onUndo={() => applyUndoRedo('undo')}
      onRedo={() => applyUndoRedo('redo')}
      onToggleSnapshots={toggleSnapshots}
      onExitCompare={exitCompareMode}
    />

    <!-- Project-level warnings banner (non-blocking; environmental risk) -->
    {#key project.path}
      <InterruptedHistory onStatus={(pending) => { interruptedHistory = pending }} onResolved={async (next) => {
        resetOpenProjectUi(); applyOpenedProject(next); workingCopyDirty = true
        await refreshSnapshots()
        showToast('Earlier and current inventories preserved. Saving can continue.')
      }} />
      <ExternalDocumentConflict onStatus={(conflicted) => { externalDocumentConflict = conflicted }} onResolved={async (next, loadedExternal) => {
        if (loadedExternal) { resetOpenProjectUi(); applyOpenedProject(next); workingCopyDirty = true }
        else project = next
        await refreshSnapshots()
        showToast('Versions preserved in additional recovery files. Saving can continue.')
      }} />
    {/key}
    {#if showProjectWarnings}
      <ProjectWarningsBanner warning={projectWarnings[0]} onDismiss={() => { projectWarningsDismissed = true }} />
    {/if}

    <!-- Load-time warnings banner (non-blocking; values left as-on-disk) -->
    {#if showLoadWarnings}
      <LoadWarningsBanner warnings={loadWarnings} onDismiss={() => { loadWarningsDismissed = true }} />
    {/if}

    <!-- Post-import summary -->
    {#if showImportSummary && importSummary}
      <ImportSummaryBanner summary={importSummary} onDismiss={() => { importSummaryDismissed = true }} />
    {/if}

    <!-- Three-pane body — tree | drag | detail | drag | snapshots -->
    <div
      class="flex flex-1 overflow-hidden"
      class:cursor-col-resize={draggingHandle !== null}
      class:select-none={draggingHandle !== null}
    >

      <!-- ── Left pane: tree + search ──────────────────────────────────── -->
      <div
        style="width: {leftPaneHandle === 'table' ? tableWidth : treeWidth}px"
        class="shrink-0 flex flex-col bg-stone-50 overflow-hidden"
      >

        <!-- Search bar -->
        <InventorySearchBar
          {project}
          {selectedId}
          query={searchQuery}
          filters={searchFilters}
          filtersActive={inventoryFiltersActive}
          filterCount={inventoryFilterCount}
          {compareMode}
          active={searchActive}
          {searching}
          loadedCount={searchResults.length}
          resultIndex={searchResultIndex}
          total={searchTotal}
          hasMore={searchHasMore}
          loadingMore={searchLoadingMore}
          bind:inputEl={searchInputEl}
          bind:filtersOpen={inventoryFiltersOpen}
          bind:viewMode={inventoryViewMode}
          onInput={handleSearchInput}
          onKeydown={handleSearchKeydown}
          onClearQuery={() => { searchQuery = ''; runSearch('') }}
          onFiltersChange={handleInventoryFiltersChange}
          onLoadMore={() => { void loadMoreSearchResults() }}
        />

        <!-- Inventory tree/table -->
        <div class="flex-1 flex flex-col overflow-hidden" data-testid="tree">
          {#if inventoryViewMode === 'table' && !compareMode && project}
            <InventoryTable
              {project}
              query={searchQuery}
              filters={searchFilters}
              {selectedId}
              bind:columns={inventoryColumns}
              bind:sortColumn={inventorySortColumn}
              bind:sortDirection={inventorySortDirection}
              onSelect={(id) => setSelection(id)}
              onMessage={showToast}
            />
          {:else}
          {#if searchActive && !searching && searchResults.length === 0}
            <div class="flex-1 p-3 text-sm text-stone-400" data-testid="search-no-results">No matching nodes</div>
          {:else}
            <div class="flex-1 overflow-hidden">
              <ProjectTreeView
                rows={flatRows}
                mode={compareMode ? 'compare' : 'browse'}
                compareContext={compareMode && mergedTree
                  ? {
                      snapshotFrom: mergedTree.fromSnapshot,
                      snapshotTo: mergedTree.toSnapshot,
                      subtreeSummaries: compareSubtreeSummaries ?? undefined,
                    }
                  : undefined}
                expandedFolds={lensExpandedFolds}
                onFoldExpand={(foldId) => {
                  const next = new Set(lensExpandedFolds)
                  if (next.has(foldId)) next.delete(foldId)
                  else next.add(foldId)
                  lensExpandedFolds = next
                }}
                {selectedId}
                {selectedIds}
                selectedScrollAlign={selectedScrollAlign}
                onSelect={handleSelect}
                onToggle={handleToggle}
                onAddChild={handleAddChild}
                onDuplicate={handleDuplicate}
                onImportHere={handleImportHere}
                onMoveUp={handleMoveUp}
                onMoveDown={handleMoveDown}
                onRenameRequest={handleRenameRequest}
                onDelete={handleDelete}
                onMoveTo={handleMoveTo}
                editingDisabled={editingLocked}
                matchedIds={searchMatchSet}
                matchQuery={searchQuery}
                matchDetails={searchResultMap}
                searchActive={searchActive}
                onSearchShortcutInput={handleSearchShortcutInput}
                onSearchClear={clearSearch}
                onSearchCycle={cycleSearchResult}
              />
            </div>
          {/if}

          {/if}

            <!-- Inline add-child input — rendered below the tree, always visible -->
            {#if addingChildTo && inventoryViewMode === 'tree'}
              <AddChildForm
                bind:name={addingChildName}
                bind:templateId={addingChildTemplateId}
                bind:inputEl={addChildInput}
                error={addingChildError}
                templateIds={addChildTemplateIds}
                templates={project.templates ?? {}}
                onCommit={commitAddChild}
                onCancel={cancelAddChild}
              />
            {/if}
        </div>

      </div>

      <!-- ── Drag handle: tree | detail ────────────────────────────────── -->
      <PaneResizeHandle
        label="Resize tree panel"
        active={draggingHandle === leftPaneHandle}
        onStart={(e) => startDrag(leftPaneHandle, e)}
      />

      <!-- ── Right pane: detail ─────────────────────────────────────────── -->
      <div class="flex-1 overflow-hidden" data-testid="detail-pane">
        {#if detailProject}
          {#if selectedNodes.length > 1 && !compareMode}
            <BatchSelectionPane
              nodes={selectedNodes}
              primaryName={selectedNode?.name ?? selectedNodes[0].name}
              readOnly={editingLocked}
              onEdit={openBatchPropertyDialog}
              onClear={() => setSelection(selectedId)}
            />
          {:else}
            <DetailPane
              node={selectedNode}
              project={detailProject}
              {renameRequestId}
              readOnly={editingLocked}
              readOnlyReason={detailReadOnlyReason(compareLabels, snapshotRestoringName, recoveryApplyingId)}
              onUpdate={handleNodeUpdate}
              onPromoteField={handlePromoteField}
              onError={showToast}
            />
          {/if}
        {/if}
      </div>

      <!-- ── Snapshots panel (docked, non-blocking) ─────────────────────── -->
      {#if snapshotPanelOpen}
        <!-- Drag handle: detail | panel -->
        <PaneResizeHandle
          label="Resize snapshots panel"
          active={draggingHandle === 'panel'}
          onStart={(e) => startDrag('panel', e)}
        />

        <!-- Controlled-width wrapper — SnapshotsPanel fills it with w-full -->
        <div style="width: {panelWidth}px" class="shrink-0 overflow-hidden">
          <SnapshotsPanel
            {snapshots}
            timelineEvents={snapshotTimelineEvents}
            recoveryPoints={snapshotRecoveryPoints}
            {mergedTree}
            compareLoaded={compareMode}
            loading={snapshotLoading}
            creating={snapshotCreating}
            comparing={snapshotComparing}
            restoringName={snapshotRestoringName}
            recoveringId={recoveryApplyingId}
            error={snapshotError}
            historyUnavailable={snapshotErrorCode === 'HISTORY_METADATA_UNAVAILABLE'}
            onHistoryRepaired={async (path) => {
              await refreshSnapshots()
              workingCopyBaseSnapshot = null
              workingCopyDirty = true
              showToast(path ? `History restored. Original preserved at ${path}` : 'History restored from automatic backup.')
            }}
            highlightedNodeId={selectedId}
            scopeCandidate={selectedNode && selectedNode.parentId !== null
              ? { id: selectedNode.id, name: selectedNode.name }
              : null}
            onDiffNodeSelect={handleDiffNodeSelect}
            onClose={closeSnapshots}
            onRefresh={refreshSnapshots}
            onCreate={handleSnapshotCreate}
            onCompare={handleSnapshotCompare}
            onExitCompare={exitCompareMode}
            onRestore={handleSnapshotRestore}
            onApplyRecovery={handleApplyRecovery}
            onExportReport={handleExportReport}
            onCopyReport={handleCopyReport}
          />
        </div>
      {/if}

      {#if revertDialogSnapshotName}
        <RevertDialog
          snapshotName={revertDialogSnapshotName}
          noteRequired={revertDialogNoteRequired}
          error={revertDialogError}
          reverting={snapshotRestoringName === revertDialogSnapshotName}
          onConfirm={confirmSnapshotRevert}
          onCancel={cancelSnapshotRevert}
        />
      {/if}

      {#if recoveryDialogPoint}
        <RecoveryDialog
          recoveryPoint={recoveryDialogPoint}
          applying={recoveryApplyingId === recoveryDialogPoint.id}
          error={recoveryDialogError}
          onConfirm={confirmRecoveryPointApply}
          onCancel={cancelRecoveryPointApply}
        />
      {/if}

    </div>
  </div>
{/if}
