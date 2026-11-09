<svelte:options runes />

<script lang="ts">
  import type { EditHistoryState } from '../../../shared/types'

  interface Props {
    brandMark: string
    projectName: string
    nodeCount: number
    modeLabel: string
    /** Compare mode is on (badge colour). */
    compareMode: boolean
    /** Compare mode is on and its merged tree has loaded (Exit Compare button). */
    compareLoaded: boolean
    reservesTrafficLightSpace: boolean
    canUndo: boolean
    editHistory: EditHistoryState
    snapshotPanelOpen: boolean
    onOpenArchives: () => void
    onUndo: () => void
    onRedo: () => void
    onToggleSnapshots: () => void
    onExitCompare: () => void
  }

  let {
    brandMark, projectName, nodeCount, modeLabel, compareMode, compareLoaded, reservesTrafficLightSpace,
    canUndo, editHistory, snapshotPanelOpen, onOpenArchives, onUndo, onRedo, onToggleSnapshots, onExitCompare,
  }: Props = $props()
</script>

<div
  class="flex items-center justify-between pr-4 py-2.5 border-b border-stone-200 bg-white
         shrink-0 {reservesTrafficLightSpace ? 'pl-20 [-webkit-app-region:drag]' : 'pl-4'}"
  data-testid="project-titlebar"
>
  <div class="flex items-center gap-3 [-webkit-app-region:no-drag]">
    <div class="flex h-10 w-10 items-center justify-center rounded-2xl bg-stone-50 ring-1 ring-stone-200">
      <img src={brandMark} alt="Statekeep logo" class="h-5 w-5" />
    </div>
    <div class="flex flex-col">
      <span class="text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-400">Statekeep</span>
      <span class="text-sm font-semibold text-stone-800">{projectName}</span>
      <span class="text-xs text-stone-400">{nodeCount} nodes</span>
    </div>
    <div
      class="max-w-[320px] truncate rounded-full border px-2.5 py-1 text-xs font-medium
             {compareMode ? 'border-sky-200 bg-sky-50 text-sky-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}"
      data-testid="project-mode-badge"
      title={modeLabel}
    >
      {modeLabel}
    </div>
  </div>
  <div class="flex items-center gap-2 [-webkit-app-region:no-drag]">
    <button onclick={onOpenArchives} class="rounded-lg border border-stone-200 px-3 py-1.5 text-xs text-stone-600" data-testid="open-archives-btn">Archives…</button>
    <button
      onclick={onUndo}
      disabled={!canUndo || !editHistory.undoLabel}
      title={editHistory.undoLabel ? `Undo ${editHistory.undoLabel.toLowerCase()}` : 'Nothing to undo'}
      class="rounded-lg border border-stone-200 px-3 py-1.5 text-xs text-stone-600 disabled:opacity-40"
      data-testid="project-undo-btn"
    >Undo</button>
    <button
      onclick={onRedo}
      disabled={!canUndo || !editHistory.redoLabel}
      title={editHistory.redoLabel ? `Redo ${editHistory.redoLabel.toLowerCase()}` : 'Nothing to redo'}
      class="rounded-lg border border-stone-200 px-3 py-1.5 text-xs text-stone-600 disabled:opacity-40"
      data-testid="project-redo-btn"
    >Redo</button>
    <button
      onclick={onToggleSnapshots}
      aria-pressed={snapshotPanelOpen ? 'true' : 'false'}
      class="rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-600
             transition-colors hover:bg-stone-50 cursor-default"
      data-testid="open-snapshots-btn"
    >
      Snapshots
    </button>
    {#if compareLoaded}
      <button
        onclick={onExitCompare}
        class="rounded-lg border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-medium text-sky-700
               transition-colors hover:bg-sky-100 cursor-default"
        data-testid="exit-compare-btn"
      >
        Exit Compare
      </button>
    {/if}
  </div>
</div>
