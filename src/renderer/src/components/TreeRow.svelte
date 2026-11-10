<svelte:options runes />

<script lang="ts">
  import type { SearchResult } from '../../../shared/types'
  import type { VisibleRow } from '../lib/tree-rows'
  import { splitHighlight } from '../lib/tree-typeahead'

  interface Props {
    position: number
    setSize: number
    row: VisibleRow
    compare?: boolean
    selected: boolean
    focused: boolean
    onSelect: (id: string, modifiers?: { toggle: boolean; range: boolean }) => void
    onToggle: (id: string) => void
    /**
     * Called when the user right-clicks this row.
     * The context menu is rendered by ProjectTreeView (outside the virtualizer
     * transform) so it doesn't get clipped by the CSS transform containing
     * block.
     */
    onContextMenu: (row: VisibleRow, x: number, y: number) => void
    /** True when this row matches the active search query. */
    matched?: boolean
    /** The active search query, for in-name substring highlighting. */
    matchQuery?: string
    matchDetail?: SearchResult
  }

  let {
    row,
    position,
    setSize,
    compare = false,
    selected,
    focused,
    onSelect,
    onToggle,
    onContextMenu,
    matched = false,
    matchQuery = '',
    matchDetail,
  }: Props = $props()

  // Segment the name for highlight only when this row is a name match.
  const nameSegments = $derived(
    matched && matchDetail?.matchField === 'name' && matchQuery
      ? splitHighlight(row.node.name, matchQuery)
      : null
  )

  const isGhost = $derived(row.kind === 'ghost')
  const nodeId = $derived(row.node.id)
  const accessibleName = $derived(row.kind === 'ghost'
    ? `${row.node.name}, ${row.status === 'removed' ? 'removed' : 'previous location'}, read only`
    : row.kind === 'decorated' && row.badges.length > 0
      ? `${row.node.name}, ${row.badges.map(badge => badge.label).join(', ')}`
      : row.node.name)

  function handleContextMenu(e: MouseEvent) {
    // Ghosts have no editable actions; suppress both the app menu (issue #3)
    // AND the OS default menu for consistency with live rows.
    e.preventDefault()
    if (isGhost) return
    onContextMenu(row, e.clientX, e.clientY)
  }

  function handleDblClick(e: MouseEvent) {
    if (isGhost) return
    e.preventDefault()
    if (row.hasChildren) onToggle(nodeId)
  }

  // Cap visual indent at depth 12 so very deep hierarchies (Region → Room →
  // Rack → Shelf → Device → Module → Sub-module → ...) don't push the node
  // name off the edge of a 288px tree column. Beyond depth 12 the indent
  // stays put; the tree is still navigable but the deeper structure is
  // implied by status badges and the user's path through it, not pixels.
  const MAX_INDENT_DEPTH = 12
  // Both compare row branches use h-16; keep them in sync with
  // COMPARE_ROW_HEIGHT in ProjectTreeView.svelte's virtualizer.
  const paddingLeft = $derived(`${Math.min(row.depth, MAX_INDENT_DEPTH) * (compare ? 10 : 16) + 8}px`)

  function getDecorationClass(): string {
    if (row.kind === 'decorated') {
      switch (row.status) {
        case 'added':            return 'bg-emerald-50 text-emerald-900'
        case 'removed':          return 'bg-red-50 text-red-800'
        case 'moved-to':         return 'bg-sky-50 text-sky-900'
        case 'renamed':          return 'bg-amber-50 text-amber-900'
        case 'property-changed': return 'bg-amber-50 text-amber-900'
        case 'template-changed': return 'bg-amber-50 text-amber-900'
        case 'order-changed':    return 'bg-stone-50 text-stone-600'
        case 'mixed':            return 'bg-purple-50 text-purple-900'
        default:                 return ''
      }
    }
    return ''
  }
</script>

{#if row.kind === 'ghost'}
  <!--
    Ghost: selectable & keyboard-navigable read-only tombstone (issue #3).
    Clicking or arrowing onto a ghost loads it into the DetailPane in
    read-only mode so the user can inspect the removed/moved-from node.
    Context menu is suppressed (no Rename/Add Child/Delete on tombstones).
    Selected state uses a muted red ring + opacity lift (40% → 70%) so the
    user sees at a glance "this is a historical row I'm inspecting".
  -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    role="treeitem"
    aria-selected={selected}
    aria-level={row.depth + 1}
    aria-posinset={position}
    aria-setsize={setSize}
    aria-label={accessibleName}
    tabindex="-1"
    class="flex items-center gap-1 rounded select-none italic text-sm cursor-default
           focus:outline-none focus:ring-1 focus:ring-stone-400
           {compare ? 'h-16 overflow-hidden' : 'h-8'}
           {selected
             ? 'opacity-70 ring-1 ring-red-300 text-stone-500'
             : 'opacity-40 text-stone-400 hover:opacity-60'}
           {focused && !selected ? 'ring-1 ring-stone-300' : ''}"
    style:padding-left={paddingLeft}
    data-testid="tree-node"
    data-node-id={nodeId}
    data-row-id={row.id}
    data-row-status={row.status}
    data-row-ghost="true"
    onclick={() => onSelect(row.id)}
    oncontextmenu={handleContextMenu}
  >
    <span class="w-4 h-4 shrink-0"></span>
    <span class="min-w-0 flex-1 {compare ? 'flex flex-col justify-center' : 'flex items-center'}">
      <span class="line-through decoration-stone-400 {compare ? 'line-clamp-2 break-words text-xs leading-4' : 'flex-1 truncate'}" title={row.node.name}>{row.node.name}</span>
      {#if compare}
        <span class="text-[10px] font-semibold uppercase tracking-wide text-stone-400">
          {row.status === 'removed' ? 'removed' : 'was here'}
        </span>
      {/if}
    </span>
    {#if !compare}
      <span class="text-[10px] font-semibold uppercase tracking-wide text-stone-400 shrink-0 mr-2">
        {row.status === 'removed' ? 'removed' : 'was here'}
      </span>
    {/if}
  </div>
{:else}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    role="treeitem"
    aria-selected={selected}
    aria-level={row.depth + 1}
    aria-posinset={position}
    aria-setsize={setSize}
    aria-label={accessibleName}
    aria-expanded={row.hasChildren ? row.expanded : undefined}
    tabindex="-1"
    class="flex items-center gap-1 rounded cursor-default text-sm select-none
           hover:bg-stone-100 focus:outline-none focus:ring-1 focus:ring-stone-400
           {compare ? 'h-16 overflow-hidden' : 'h-8'}
           {selected ? '!bg-stone-200 !text-stone-900' : 'text-stone-700'}
           {focused && !selected ? 'ring-1 ring-stone-300' : ''}
           {matched && !selected ? 'ring-1 ring-amber-300' : ''}
           {getDecorationClass()}"
    style:padding-left={paddingLeft}
    data-testid="tree-node"
    data-node-id={nodeId}
    data-row-id={row.id}
    data-row-status={row.kind === 'decorated' ? row.status : undefined}
    data-row-matched={matched ? 'true' : undefined}
    onclick={(event) => onSelect(nodeId, { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey })}
    ondblclick={handleDblClick}
    oncontextmenu={handleContextMenu}
  >
    <!-- Expand/collapse chevron -->
    <button
      class="w-4 h-4 flex items-center justify-center shrink-0 text-stone-400
             hover:text-stone-600 [-webkit-app-region:no-drag]"
      onclick={(e) => { e.stopPropagation(); if (row.hasChildren) onToggle(nodeId) }}
      tabindex="-1"
      aria-label={row.expanded ? 'Collapse' : 'Expand'}
    >
      {#if row.hasChildren}
        <svg
          class="w-3 h-3 transition-transform {row.expanded ? 'rotate-90' : ''}"
          viewBox="0 0 12 12"
        >
          <path
            d="M4 2l4 4-4 4"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            fill="none"
          />
        </svg>
      {/if}
    </button>

    <!-- Node name (segmented when it matches the active search query) -->
    <div class="min-w-0 flex-1 {compare ? 'flex flex-col justify-center gap-0.5' : 'flex items-center gap-1'}">
      <span class="min-w-0 {compare ? 'line-clamp-2 break-words text-xs leading-4' : 'flex-1 truncate'}" title={row.node.name} data-testid="tree-node-name">
        {#if nameSegments}
          {#each nameSegments as seg, i (i)}
            {#if seg.match}<mark class="rounded bg-amber-200 text-amber-900">{seg.text}</mark>{:else}{seg.text}{/if}
          {/each}
        {:else}
          {row.node.name}
        {/if}
      </span>

      {#if matched && matchDetail?.matchField === 'property'}
        <span
          class="{compare ? 'max-w-full' : 'max-w-[42%]'} truncate rounded bg-amber-100 px-1.5 py-0.5 text-[10px]
                 font-medium text-amber-800"
          title={matchDetail.snippet}
        >
          {matchDetail.snippet}
        </span>
      {/if}

      <!-- Decorated badges (compare mode, PR #2) -->
      {#if row.kind === 'decorated' && row.badges.length > 0}
        <div class="flex items-center gap-1 {compare ? 'min-w-0 overflow-hidden' : 'shrink-0'}">
          {#each row.badges as badge (badge.kind)}
            <span
              class="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide
                     {badge.severity === 'High' ? 'bg-amber-100 text-amber-700' :
                      badge.severity === 'Medium' ? 'bg-sky-100 text-sky-700' :
                      'bg-stone-100 text-stone-500'}"
            >
              {badge.label}
            </span>
          {/each}
        </div>
      {/if}

      <!-- Collapsed child count — shown as a plain number, not a button -->
      {#if row.hasChildren && !row.expanded}
        <span class="text-xs text-stone-400 tabular-nums shrink-0 mr-1">
          {row.childCount}
        </span>
      {/if}
    </div>
  </div>
{/if}
