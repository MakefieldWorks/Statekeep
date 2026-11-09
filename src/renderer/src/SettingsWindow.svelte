<svelte:options runes />

<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import type { LaunchBehavior } from '../../shared/ipc'
  import {
    DEFAULT_APPEARANCE_PREFERENCE,
    themesForScheme,
    type AppearanceMode,
    type AppearancePreference,
    type ThemeScheme,
  } from '../../shared/theme'

  type SettingsSection = 'general' | 'workspace'

  const desktopChrome = window.api.platform
  const lightThemes = themesForScheme('light')
  const darkThemes = themesForScheme('dark')
  let activeSection: SettingsSection = $state('general')
  let launchBehavior: LaunchBehavior = $state('project-hub')
  let appearanceMode: AppearanceMode = $state('system')
  let lightThemeId: string = $state(DEFAULT_APPEARANCE_PREFERENCE.lightThemeId)
  let darkThemeId: string = $state(DEFAULT_APPEARANCE_PREFERENCE.darkThemeId)
  let loading = $state(true)
  let saving = $state(false)
  let resetting = $state(false)
  let status: string | null = $state(null)
  let error: string | null = $state(null)
  let unsubscribeWindowFocus: (() => void) | null = null

  function applyWindowFocus(isFocused: boolean) {
    document.documentElement.dataset.windowFocused = String(isFocused)
  }

  function closeSettings() {
    void window.api.settings.closeWindow()
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return
    event.preventDefault()
    closeSettings()
  }

  onMount(async () => {
    unsubscribeWindowFocus = window.api.windowState.onFocusChanged(applyWindowFocus)
    const focusState = await window.api.windowState.isFocused()
    if (focusState.ok) applyWindowFocus(focusState.data)

    const preferences = await window.api.settings.getPreferences()
    if (preferences.ok) {
      launchBehavior = preferences.data.launchBehavior
      applyAppearancePreference(preferences.data.appearance)
    } else {
      error = `Could not load settings: ${preferences.error.message}`
    }
    loading = false
    window.addEventListener('keydown', handleKeydown)
  })

  onDestroy(() => {
    unsubscribeWindowFocus?.()
    window.removeEventListener('keydown', handleKeydown)
    delete document.documentElement.dataset.windowFocused
  })

  async function saveLaunchBehavior(next: LaunchBehavior) {
    launchBehavior = next
    saving = true
    error = null
    status = null
    const result = await window.api.settings.updatePreferences({ launchBehavior: next })
    saving = false
    if (!result.ok) {
      error = `Could not save settings: ${result.error.message}`
      return
    }
    status = 'Saved. This will take effect the next time Statekeep starts.'
  }

  function applyAppearancePreference(preference: AppearancePreference) {
    appearanceMode = preference.mode
    lightThemeId = preference.lightThemeId
    darkThemeId = preference.darkThemeId
  }

  async function saveAppearance(patch: Partial<AppearancePreference>) {
    saving = true
    error = null
    status = null
    const result = await window.api.settings.updatePreferences({ appearance: patch })
    saving = false
    if (!result.ok) {
      error = `Could not save appearance: ${result.error.message}`
      return
    }
    applyAppearancePreference(result.data.appearance)
    status = 'Appearance updated.'
  }

  function saveAppearanceMode(next: AppearanceMode) {
    appearanceMode = next
    void saveAppearance({ mode: next })
  }

  function saveTheme(scheme: ThemeScheme, nextId: string) {
    if (scheme === 'light') lightThemeId = nextId
    else darkThemeId = nextId
    void saveAppearance(scheme === 'light' ? { lightThemeId: nextId } : { darkThemeId: nextId })
  }

  async function resetLayout() {
    resetting = true
    error = null
    status = null
    const result = await window.api.settings.resetLayout()
    resetting = false
    if (!result.ok) {
      error = `Could not reset layout: ${result.error.message}`
      return
    }
    status = 'Window size and pane layout reset.'
  }
</script>

<svelte:head>
  <title>Statekeep Settings</title>
</svelte:head>

{#if desktopChrome.supportsWindowDragRegion}
  <div
    class="fixed inset-x-0 top-0 z-50 h-8 [-webkit-app-region:drag]"
    data-testid="settings-window-drag-region"
  ></div>
{/if}

<main class="flex h-full min-h-0 bg-stone-50 text-stone-800">
  <aside class="flex w-52 shrink-0 flex-col border-r border-stone-200 bg-stone-100/70 px-3 py-5 {desktopChrome.reservesTrafficLightSpace ? 'pt-12' : ''}">
    <div class="flex items-center gap-2.5 px-2 pb-6 [-webkit-app-region:no-drag]">
      <div class="flex h-7 w-7 items-center justify-center rounded-md bg-white ring-1 ring-stone-200">
        <img src="./statekeep-mark.svg" alt="" class="h-4 w-4" />
      </div>
      <span class="text-sm font-semibold tracking-tight text-stone-800">Statekeep</span>
    </div>

    <nav aria-label="Settings categories" class="space-y-1 [-webkit-app-region:no-drag]">
      <button
        type="button"
        onclick={() => { activeSection = 'general' }}
        aria-current={activeSection === 'general' ? 'page' : undefined}
        class="flex w-full items-center rounded-md px-3 py-2 text-left text-sm font-medium {activeSection === 'general' ? 'bg-white text-stone-900 shadow-sm ring-1 ring-stone-200' : 'text-stone-600 hover:bg-stone-200/70 hover:text-stone-800'}"
        data-testid="settings-general-nav"
      >
        General
      </button>
      <button
        type="button"
        onclick={() => { activeSection = 'workspace' }}
        aria-current={activeSection === 'workspace' ? 'page' : undefined}
        class="flex w-full items-center rounded-md px-3 py-2 text-left text-sm font-medium {activeSection === 'workspace' ? 'bg-white text-stone-900 shadow-sm ring-1 ring-stone-200' : 'text-stone-600 hover:bg-stone-200/70 hover:text-stone-800'}"
        data-testid="settings-workspace-nav"
      >
        Workspace
      </button>
    </nav>

    <button
      type="button"
      onclick={closeSettings}
      class="mt-auto rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 shadow-sm hover:bg-stone-50 focus:outline-none focus:ring-2 focus:ring-stone-200 [-webkit-app-region:no-drag]"
      data-testid="settings-done"
    >
      Done
    </button>
  </aside>

  <div class="min-w-0 flex-1 overflow-y-auto overscroll-contain" data-testid="settings-scroll-region">
    <div class="mx-auto max-w-2xl px-8 py-8">
      {#if activeSection === 'general'}
        <header class="border-b border-stone-200 pb-6">
          <h1 class="text-xl font-semibold tracking-tight text-stone-900">General</h1>
          <p class="mt-1.5 text-sm text-stone-500">Application behavior that applies to every Statekeep project.</p>
        </header>

        <section class="pt-7" aria-labelledby="appearance-heading">
          <h2 id="appearance-heading" class="text-xs font-semibold uppercase tracking-[0.14em] text-stone-500">Appearance</h2>
          <div class="mt-3 divide-y divide-stone-100 overflow-hidden rounded-lg border border-stone-200 bg-white">
            <div class="flex items-center justify-between gap-8 px-5 py-4">
              <div class="min-w-0">
                <label for="theme-preference" class="text-sm font-medium text-stone-800">Appearance mode</label>
                <p class="mt-1 text-xs leading-5 text-stone-500">Follow your system or keep Statekeep in a fixed light or dark appearance.</p>
              </div>
              <select
                id="theme-preference"
                value={appearanceMode}
                onchange={(event) => void saveAppearanceMode((event.currentTarget as HTMLSelectElement).value as AppearanceMode)}
                disabled={loading || saving}
                class="w-48 shrink-0 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-800 shadow-sm outline-none focus:border-stone-500 focus:ring-2 focus:ring-stone-200 disabled:opacity-50"
                data-testid="theme-preference"
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                </select>
            </div>
            <div class="flex items-center justify-between gap-8 px-5 py-4">
              <div class="min-w-0">
                <label for="light-theme-preference" class="text-sm font-medium text-stone-800">Light scheme</label>
                <p class="mt-1 text-xs leading-5 text-stone-500">Used in Light mode and whenever System appearance is light.</p>
              </div>
              <select
                id="light-theme-preference"
                value={lightThemeId}
                onchange={(event) => saveTheme('light', (event.currentTarget as HTMLSelectElement).value)}
                disabled={loading || saving}
                class="w-48 shrink-0 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-800 shadow-sm outline-none focus:border-stone-500 focus:ring-2 focus:ring-stone-200 disabled:opacity-50"
                data-testid="light-theme-preference"
              >
                {#each lightThemes as theme}
                  <option value={theme.id}>{theme.label}</option>
                {/each}
              </select>
            </div>
            <div class="flex items-center justify-between gap-8 px-5 py-4">
              <div class="min-w-0">
                <label for="dark-theme-preference" class="text-sm font-medium text-stone-800">Dark scheme</label>
                <p class="mt-1 text-xs leading-5 text-stone-500">Used in Dark mode and whenever System appearance is dark.</p>
              </div>
              <select
                id="dark-theme-preference"
                value={darkThemeId}
                onchange={(event) => saveTheme('dark', (event.currentTarget as HTMLSelectElement).value)}
                disabled={loading || saving}
                class="w-48 shrink-0 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-800 shadow-sm outline-none focus:border-stone-500 focus:ring-2 focus:ring-stone-200 disabled:opacity-50"
                data-testid="dark-theme-preference"
              >
                {#each darkThemes as theme}
                  <option value={theme.id}>{theme.label}</option>
                {/each}
              </select>
            </div>
          </div>
        </section>

        <section class="pt-8" aria-labelledby="startup-heading">
          <h2 id="startup-heading" class="text-xs font-semibold uppercase tracking-[0.14em] text-stone-500">Startup</h2>
          <div class="mt-3 divide-y divide-stone-100 overflow-hidden rounded-lg border border-stone-200 bg-white">
            <div class="flex items-center justify-between gap-8 px-5 py-4">
              <div class="min-w-0">
                <label for="launch-behavior" class="text-sm font-medium text-stone-800">When Statekeep starts</label>
                <p class="mt-1 text-xs leading-5 text-stone-500">A project opened from Finder or Explorer always takes priority.</p>
              </div>
              <select
                id="launch-behavior"
                value={launchBehavior}
                onchange={(event) => void saveLaunchBehavior((event.currentTarget as HTMLSelectElement).value as LaunchBehavior)}
                disabled={loading || saving}
                class="w-48 shrink-0 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-800 shadow-sm outline-none focus:border-stone-500 focus:ring-2 focus:ring-stone-200 disabled:opacity-50"
                data-testid="launch-behavior"
              >
                <option value="project-hub">Open Project Hub</option>
                <option value="reopen-last-project">Reopen last project</option>
              </select>
            </div>
          </div>
        </section>
      {:else}
        <header class="border-b border-stone-200 pb-6">
          <h1 class="text-xl font-semibold tracking-tight text-stone-900">Workspace</h1>
          <p class="mt-1.5 text-sm text-stone-500">Restore Statekeep’s working layout without changing any project data.</p>
        </header>

        <section class="pt-7" aria-labelledby="layout-heading">
          <h2 id="layout-heading" class="text-xs font-semibold uppercase tracking-[0.14em] text-stone-500">Layout</h2>
          <div class="mt-3 divide-y divide-stone-100 overflow-hidden rounded-lg border border-stone-200 bg-white">
            <div class="flex items-center justify-between gap-8 px-5 py-4">
              <div class="min-w-0">
                <p class="text-sm font-medium text-stone-800">Reset window and panes</p>
                <p class="mt-1 text-xs leading-5 text-stone-500">Restore the default window size and sidebar widths. Projects and recent-project history are kept.</p>
              </div>
              <button
                type="button"
                onclick={() => void resetLayout()}
                disabled={resetting}
                class="shrink-0 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-700 shadow-sm hover:bg-stone-50 focus:outline-none focus:ring-2 focus:ring-stone-200 disabled:opacity-50"
                data-testid="reset-layout"
              >
                {resetting ? 'Resetting…' : 'Reset Layout'}
              </button>
            </div>
          </div>
        </section>
      {/if}

      {#if error}
        <div class="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {error}
        </div>
      {/if}
      {#if status}
        <p class="mt-5 text-sm text-emerald-700" role="status">{status}</p>
      {/if}
    </div>
  </div>
</main>
