<svelte:options runes />
<script lang="ts">
  import { onMount } from 'svelte'
  import type { ProjectArchivePreview } from '../../../shared/types'
  let { canExport, onClose }: { canExport: boolean; onClose: () => void } = $props()
  let busy = $state(false)
  let preview: ProjectArchivePreview | null = $state(null)
  let message: string | null = $state(null)
  let error: string | null = $state(null)
  let element: HTMLDialogElement
  onMount(() => { element.showModal() })
  async function run(action: 'export' | 'inspect' | 'restore') {
    if (busy) return
    busy = true
    error = null
    message = null
    try {
      if (action === 'export') {
        const result = await window.api.archive.export()
        if (!result.ok) error = result.error.message
        else if (result.data) message = `Verified archive saved at ${result.data.path}`
      } else if (action === 'inspect') {
        preview = null
        const result = await window.api.archive.inspect()
        if (!result.ok) error = result.error.message
        else preview = result.data
      } else if (preview) {
        const result = await window.api.archive.restore({ token: preview.token })
        if (!result.ok) { error = result.error.message; preview = null }
        else if (result.data) {
          message = `Verified project restored at ${result.data.path}. Use Open Project to open this folder; its search and history indexes will rebuild automatically.`
          preview = null
        }
      }
    } catch (failure) { error = String(failure) }
    finally { busy = false }
  }
</script>

  <dialog bind:this={element} oncancel={(event) => { event.preventDefault(); if (!busy) onClose() }} aria-label="Project archives" class="max-h-[90vh] w-full max-w-lg space-y-4 overflow-auto rounded-xl bg-white p-6 text-sm text-stone-700 shadow-xl backdrop:bg-black/30" data-testid="project-archive-dialog">
    <h2 class="text-lg font-semibold">Project archives</h2>
    <p>Keep a portable copy of current inventory, snapshots, history records, and saved recovery files. Current unsaved inventory edits are included when exporting.</p>
    <p>Search indexes rebuild on open. Session Undo/Redo, Git settings, hooks, remotes, other branches, and files outside Statekeep’s history records are excluded.</p>
    {#if error}<p role="alert" class="text-red-700">{error}</p>{/if}
    {#if message}<p role="status" class="break-words rounded bg-emerald-50 p-3 selectable">{message}</p>{/if}
    <div class="flex gap-2">
      {#if canExport}<button disabled={busy} onclick={() => run('export')} class="rounded border border-stone-300 px-3 py-2 disabled:opacity-50" data-testid="archive-export">Export archive…</button>{/if}
      <button disabled={busy} onclick={() => run('inspect')} class="rounded border border-stone-300 px-3 py-2 disabled:opacity-50" data-testid="archive-review">Review archive…</button>
    </div>
    {#if preview}
      <div class="space-y-2 rounded border border-stone-200 p-3" data-testid="archive-preview">
        <h3 class="font-semibold">{preview.projectName}</h3>
        <p>Archived {new Date(preview.createdAt).toLocaleString()}</p>
        <p>{preview.snapshotCount} snapshots · {preview.recoveryFileCount} recovery files</p>
        <p>Restore creates a new folder inside the location you choose. Existing projects stay unchanged. The restored copy keeps the original project identity.</p>
        <button disabled={busy} onclick={() => run('restore')} class="rounded bg-stone-800 px-3 py-2 text-white disabled:opacity-50" data-testid="archive-restore">Restore into a new folder…</button>
        <button disabled={busy} onclick={() => { preview = null }} class="ml-2 rounded border border-stone-300 px-3 py-2">Cancel</button>
      </div>
    {/if}
    {#if busy}<p role="status">Verifying project archive…</p>{/if}
    <button disabled={busy} onclick={onClose} class="rounded border border-stone-300 px-3 py-2 disabled:opacity-50">Close</button>
  </dialog>
