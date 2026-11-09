<svelte:options runes />

<script lang="ts">
  interface Props {
    brandMark: string
    error: string | null
    /** Bound: the parent owns the draft name and clears it on close. */
    name: string
    path: string
    creating: boolean
    onChooseFolder: () => void
    onCancel: () => void
    onCreate: () => void
  }

  let { brandMark, error, name = $bindable(), path, creating, onChooseFolder, onCancel, onCreate }: Props = $props()
</script>

<div class="flex flex-col h-full items-center justify-center bg-stone-50">
  <div class="flex flex-col gap-5 w-full max-w-sm px-6">

    <div class="flex items-center gap-3">
      <div class="flex h-12 w-12 items-center justify-center rounded-2xl bg-white ring-1 ring-stone-200">
        <img src={brandMark} alt="Statekeep logo" class="h-7 w-7" />
      </div>
      <div>
        <h2 class="text-lg font-semibold text-stone-800">New Project</h2>
        <p class="text-sm text-stone-400 mt-0.5">A folder will be created at the chosen location.</p>
      </div>
    </div>

    {#if error}
      <div class="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
        {error}
      </div>
    {/if}

    <div class="flex flex-col gap-1.5">
      <label class="text-xs font-medium text-stone-600 uppercase tracking-wide" for="proj-name">
        Project Name
      </label>
      <input
        id="proj-name"
        type="text"
        bind:value={name}
        placeholder="Lab Bench A"
        class="w-full bg-white border border-stone-200 rounded-lg px-3 py-2 text-sm
               text-stone-800 placeholder-stone-300 focus:outline-none focus:ring-2
               focus:ring-stone-400 focus:border-transparent selectable"
        onkeydown={(e) => e.key === 'Enter' && onCreate()}
        data-testid="project-name-input"
      />
    </div>

    <div class="flex flex-col gap-1.5">
      <span class="text-xs font-medium text-stone-600 uppercase tracking-wide">Location</span>
      <div class="flex gap-2">
        <div class="flex-1 bg-white border border-stone-200 rounded-lg px-3 py-2 text-sm
                    text-stone-500 truncate min-w-0" data-testid="selected-path">
          {path || 'No folder selected'}
        </div>
        <button
          onclick={onChooseFolder}
          class="shrink-0 bg-white hover:bg-stone-50 text-stone-600 text-sm
                 px-3 py-2 rounded-lg border border-stone-200 transition-colors cursor-default"
          data-testid="choose-folder-btn"
        >
          Choose…
        </button>
      </div>
    </div>

    <div class="flex gap-2 pt-1">
      <button
        onclick={onCancel}
        class="flex-1 bg-white hover:bg-stone-50 text-stone-600 text-sm font-medium
               px-4 py-2.5 rounded-lg border border-stone-200 transition-colors cursor-default"
      >
        Cancel
      </button>
      <button
        onclick={onCreate}
        disabled={!name.trim() || !path || creating}
        class="flex-1 bg-stone-800 hover:bg-stone-700 disabled:bg-stone-300
               text-white text-sm font-medium px-4 py-2.5 rounded-lg
               transition-colors cursor-default disabled:cursor-not-allowed"
        data-testid="create-btn"
      >
        {creating ? 'Creating…' : 'Create'}
      </button>
    </div>

  </div>
</div>
