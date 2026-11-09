# External project-file changes

Statekeep remembers a SHA-256 fingerprint of the exact project document bytes it
opened or last saved. Save checks that fingerprint before writing and again
before replacing the file. Changes, deletion, unreadable files, and links pause
saving instead of overwriting the outside version. This includes autosave and
the final save before close/quit. Focus checks detect changes when returning
from another application; there is no background filesystem watcher.

Detection preserves current inventory in a unique, unlisted
`.statekeep/recovery/recovery-<uuid>-local.document.json` file. The status reports
the copy's location. Repeated failures reuse the copy while it remains intact.
If preservation fails, the status explicitly says to keep the project open;
an explicit Close/Quit Anyway still discards unsaved memory in that case.
Successful copies remain available through recovery-file reconciliation even
after an explicit discard. They are not automatically pruned.

The banner makes the current inventory read-only until resolution. Autosave,
undo/redo, snapshots, revert, recovery, archive export, and recovery metadata
mutations cannot overwrite the detected outside state. **Retry save** is useful
when the external program has restored the original bytes; it does not bypass
the fingerprint check.

## Review and choose

**Review both versions** shows inventory counts and whether the external file
is valid for the same project. Cancel preserves the conflict and changes no
files. A preview token includes the current in-memory inventory, baseline,
project identity/path, and external bytes. Stale previews require another review.

Both choices preserve available local and external bytes as additional recovery
files before proceeding. Malformed external bytes are preserved verbatim;
missing files have no external bytes to copy. Resolution requires writable local
recovery directories in the existing project folder. Unreadable, linked, or
oversized external files must first be restored to a readable regular document;
Statekeep will not discard bytes it cannot preserve. A moved project folder must
be restored to its original location.

- **Keep current** explicitly writes the current inventory over the external
  file (or recreates a missing file). Current Undo/Redo remains available.
- **Load external** leaves the external file in place, replaces current
  inventory, clears Undo/Redo, and clears assumed snapshot baseline/revert
  lineage. It is available only for a valid project with the same identity.
  This choice also requires readable history metadata; Keep current does not.

Copies are unlisted until explicitly added through **Additional recovery files**.
No automatic merging or invented timeline event occurs. Ordinary history events
remain intact, and metadata backups are protected before resolution.

## Operation boundaries

History operations check the current document before writing metadata backups,
creating safety files, or changing Git. Snapshot creation additionally checks
that the staged document exactly matches Statekeep's saved bytes. A mismatch
unstages the document and aborts before commit/tag creation.

These checks do not provide a filesystem transaction against arbitrary external
writers. A writer can still race the final check and rename, modify Git's index
after verification, or interfere with an operation already in progress. Existing
multi-file crash windows remain separate work. There is no merge engine, file
watcher, or protection for external edits to history metadata in this increment.

Tests cover save/autosave, focus, close, snapshot/revert/archive protection,
preserved local edits after explicit discard, both choices, missing/invalid/
foreign external files, stale reviews, and a write between save and staging.
Electron tests cover the banner, Cancel, both resolution choices, and preserved
copies with the expected Undo/Redo behavior.
