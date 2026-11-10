<svelte:options runes />

<script lang="ts">
  import type { RecentProject } from '../../../shared/ipc'

  interface Props {
    brandMark: string
    error: string | null
    recentProjects: RecentProject[]
    onOpenArchives: () => void
    onCreateProject: () => void
    onOpenProject: () => void
    onOpenRecent: (recentProject: RecentProject) => void
    onOpenExample: () => void
  }

  let { brandMark, error, recentProjects, onOpenArchives, onCreateProject, onOpenProject, onOpenRecent, onOpenExample }: Props = $props()
</script>

<div class="flex h-full bg-stone-50">
  <div class="flex w-full max-w-4xl flex-col px-10 py-10 mx-auto">
    <header class="flex items-center justify-between border-b border-stone-200 pb-6">
      <div class="flex items-center gap-3">
        <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-white ring-1 ring-stone-200">
          <img src={brandMark} alt="Statekeep logo" class="h-6 w-6" />
        </div>
        <div>
          <h1 class="text-lg font-semibold tracking-tight text-stone-800">Statekeep</h1>
          <p class="mt-0.5 text-sm text-stone-500">Projects</p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button onclick={onOpenArchives} class="rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-700" data-testid="open-archives-btn">Archives…</button>
        <button
          onclick={onCreateProject}
          class="rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 cursor-default"
          data-testid="create-project-btn"
        >
          New Project…
        </button>
        <button
          onclick={onOpenProject}
          class="rounded-lg bg-stone-800 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-stone-700 cursor-default"
          data-testid="open-project-btn"
        >
          Open Project…
        </button>
      </div>
    </header>

    {#if error}
      <div class="mt-6 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 rounded-lg">
        {error}
      </div>
    {/if}

    <main class="pt-8">
      <div class="mb-6 rounded-lg border border-stone-200 bg-white p-4">
        <h2 class="text-sm font-semibold text-stone-800">Start with a ready-to-use project</h2>
        <p class="mt-1 text-sm text-stone-500">Explore a test lab, network equipment, or maintenance starter with typed fields and sample snapshots.</p>
        <button onclick={onCreateProject} class="mt-3 rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700" data-testid="browse-starters-btn">Browse project starters…</button>
      </div>
      <h2 class="text-xs font-semibold uppercase tracking-[0.14em] text-stone-500">Recent projects</h2>
      {#if recentProjects.length > 0}
        <div class="mt-3 overflow-hidden rounded-lg border border-stone-200 bg-white" data-testid="recent-project-list">
          {#each recentProjects as recentProject, index (recentProject.path)}
            <button
              onclick={() => onOpenRecent(recentProject)}
              disabled={!recentProject.exists}
              class="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-stone-50 disabled:cursor-not-allowed disabled:bg-stone-50 disabled:opacity-50 {index > 0 ? 'border-t border-stone-100' : ''}"
              data-testid={index === 0 ? 'reopen-last-project-btn' : 'recent-project-btn'}
            >
              <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-stone-100 text-xs font-semibold text-stone-500">
                {recentProject.name.slice(0, 1).toUpperCase()}
              </div>
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-medium text-stone-800">{recentProject.name}</div>
                <div class="mt-0.5 truncate text-xs text-stone-500">{recentProject.path}</div>
              </div>
              {#if !recentProject.exists}
                <span class="text-xs font-medium text-stone-400">Unavailable</span>
              {/if}
            </button>
          {/each}
        </div>
      {:else}
        <div class="mt-3 rounded-lg border border-dashed border-stone-300 bg-white px-5 py-8 text-sm text-stone-500" data-testid="empty-recent-projects">
          <p>No recent projects. Open an existing project or create a new one to get started.</p>
          <button
            onclick={onOpenExample}
            class="mt-4 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100"
            data-testid="open-example-project-btn"
          >
            Open Example Project
          </button>
          <p class="mt-2 text-xs text-stone-400">Explore templates and snapshot history in a reusable sample saved to your Documents folder.</p>
        </div>
      {/if}
    </main>
  </div>
</div>
