# Undo and Redo

Statekeep keeps editing history for the Current Project while it is open. Use
the Undo/Redo toolbar buttons, Edit menu, or keyboard shortcuts:

- Undo: Cmd+Z on macOS; Ctrl+Z on Windows/Linux.
- Redo: Cmd+Shift+Z on macOS; Ctrl+Y on Windows; Ctrl+Shift+Z on Linux.

When a text field has focus, the keyboard shortcuts and Edit menu apply to that
field's native text history. They never fall through to project history when
the text history is empty. The toolbar always operates on project edits.

## What is restored

Each successful operation is one history entry: add, duplicate subtree, rename, property edit,
template assignment, move/reorder, delete subtree, template create/update/delete,
CSV import, or NetBox import. Undoing a force-delete restores both the deleted
nodes and any references/template defaults that were cleared. Imports restore
their created or updated nodes and generated templates together. Original node
IDs and ordering are preserved, and the search index is updated.

Duplicating creates new IDs for the copied node and every descendant. The copy
appears immediately after the source sibling; descendants retain their ordering.
Typed references within the copied subtree point to the new IDs. External
references keep their targets, and references from existing nodes still point to
the originals. Free-text values are never remapped. Templates and their defaults
remain shared; all existing property values, including serial numbers, are copied.
The project root cannot be duplicated. Undo removes the entire copy and restores
sibling ordering; Redo restores the same copied IDs.

Failed operations and changes that only alter timestamps do not consume history.
A new successful edit after Undo clears Redo. Autosave and Save Now preserve both
stacks. Undo/Redo results are autosaved just like ordinary edits and flushed when
closing the project.

## Boundaries

- Saving a snapshot preserves edit history. Undo changes only the Current
  Project; it never changes or removes that snapshot.
- Compare is read-only: project Undo/Redo is disabled until compare is exited.
- Revert and recovery clear editing history once the replacement document has
  been written. Their confirmation dialogs explain this. Snapshot recovery
  remains the way to retrieve work from before those operations.
- Closing, reopening, switching, or creating a project clears editing history.
  The stacks are session-only and are not stored in the project document.
- Project Undo/Redo is unavailable during modal editing/import and while
  snapshot, revert, recovery, or another undo/redo operation is running.

## Implementation

`src/main/edit-history.ts` captures changed node records, their array positions,
and changed template maps. It does not retain whole project snapshots. Captures
are cloned so later caller mutations cannot change history. The default limit
is 100 operations and approximately 64 MiB of serialized history; oldest entries
are evicted first. A single latest operation is retained even if it exceeds the
byte budget, so a large import remains undoable.

`ProjectManager.commitProjectMutation` records an entry only after successful
search synchronization. Undo/Redo prepares the target project, rebuilds search,
then advances its stacks and schedules autosave. If indexing fails, the old
project and stack positions are preserved and the previous index is restored.
Snapshot/revert/recovery operations exclude concurrent edit-history transitions.

The typed IPC surface exposes `project.undo`, `project.redo`, and
`project.editHistory`. Native text undo is a separate validated command targeting
only the caller's web contents. The renderer refreshes history availability when
project state changes and discards stale status responses.
