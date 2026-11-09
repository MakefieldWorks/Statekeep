# Interrupted history operations

Snapshot creation, snapshot revert, recovery-point application, recovery-file
registration/removal, and history-backup restoration now preserve the current
inventory (including unsaved edits) and earlier history metadata before changing
the project. Metadata-only operations preserve the history file's exact bytes,
including damage or absence. A versioned `.statekeep/history-operation.json`
record is published after those copies have been flushed to disk. The record
identifies the operation and fingerprints both copies. Snapshot, revert, and
recovery records also include the operation kind, intended timeline-event ID
and target, and expected document fingerprint. Metadata-only records bind the
expected history bytes and document fingerprint. Backup restoration retains the exact source backup and records
whether the earlier history file was missing. Existing version-1 records remain
supported through manual review.

The record remains until the operation reports success or safely rolls back.
An uncertain failure,
process termination, or interruption after the history commit but before cleanup
therefore leaves evidence for the next session. A cleanup failure after a
successful commit still reports the operation as successful. Statekeep immediately
retries exact classification after a cleanup failure and checks again on the next
open. It automatically recognizes snapshot/revert/recovery completion only when
the record, document, last timeline event, lineage pointers, and immutable Git
snapshot (for snapshot creation and revert) all agree exactly. Metadata-only
completion requires exact expected history bytes and an unchanged document.
Recovery registration also checks that its source payload is unchanged.
Backup restoration also requires the preserved damaged original (when present)
and source backup to match. It then retains the before-state evidence and
resumes without a banner. Missing or conflicting proof remains in manual review.
Statekeep never replays Git commands. Editing, Undo/Redo,
saving, final save on close, new history mutations, and archive export pause
until the user reviews the unfinished operation. Read-only inspection remains
available. Derived history-index backfill is not started while evidence is pending.

## Review and continue

The banner opens a review showing the operation, start time, current and earlier
node counts, and the preserved inventory's location. Cancel changes nothing.
The preview token covers the record, preserved copies, current inventory,
document bytes, and current history. For metadata-only operations it binds the
exact current history bytes or their absence. A changed preview must be reviewed again.

**Continue with current inventory** is explicit acknowledgement, not rollback or
automatic repair of lost metadata. It preserves another copy of the current
inventory and current history, saves the current inventory, clears Undo/Redo,
and clears its assumed snapshot baseline and pending-revert association. Existing
Git commits/tags and history events remain unchanged. A snapshot created before
an interruption may exist without its original note or timeline event; Statekeep
does not invent those. The pending record is moved to the recovery directory,
retaining all evidence. The earlier inventory can subsequently be reviewed and
added through **Additional recovery files**, then applied through normal recovery.
If current history is missing, no continued-history copy is written; the retained
before-state history evidence remains in the recovery directory after continuation.

For a metadata-only operation, **Continue** keeps the current inventory and
history bytes as they are. It preserves the earlier inventory, exact earlier
history bytes (including damage or absence), source backup when applicable, and
a copy of the current state. It does not replay registration or restoration,
reset lineage, or invent a timeline event. If current history remains damaged or
missing, the automatic-backup review can be retried after continuation.

If acknowledgement fails, the pending record remains for a fresh review/retry.
If a snapshot/revert/recovery record coexists with unreadable current history,
explicit continuation preserves the damaged bytes and current inventory without
inventing or clearing lineage; the automatic-backup review can then restore history.
Unreadable history can be restored through the automatic-backup review after
continuation; outside document changes can be resolved through the external-change
review. Neither review silently clears the unfinished-operation record. Missing, altered, linked,
or unsupported evidence requires manual recovery and is never silently discarded.

Normal successful operations remove their temporary before-state copies. Copies
retained after an interrupted operation are deliberate recovery/audit evidence:
Statekeep does not expire or cap them because automatic deletion could remove the
only surviving pre-operation inventory. They use the existing recovery directory
and are included in portable archives once the unfinished operation has been
acknowledged. The user-reviewed cleanup workflow below provides explicit
retention management without silently deleting this evidence.

## Review and delete retained evidence

The Snapshots panel lists verified retained evidence groups separately from
Additional recovery files. Each review is limited to 100 groups and shows the
operation, date, before/current node counts, combined size, and exact three or four
filenames. Malformed, altered, incomplete, linked, or otherwise unverifiable
groups are counted and left untouched.
When current history is missing or unreadable, groups remain inspectable, but
deletion waits until readable history is restored so recovery registrations can be checked.

Deletion is available for one group at a time after an explicit permanent-action
confirmation. Its token covers the exact operation record, its evidence files,
and current history metadata. Statekeep revalidates all of them immediately before
deleting. If the before-state inventory is registered under Additional recovery
files, deletion remains blocked until that registration is explicitly removed.
An active pending operation also blocks the workflow.

The archived operation record is removed first so an interrupted cleanup can
never present a partial group as intact. Its linked payloads are then removed.
If a payload cannot be deleted, it remains ordinary recovery material and
Statekeep reports its exact filename. Unrelated and unrecognized files are never
deleted. Exporting a portable archive before cleanup is the safer choice when the
evidence may still be useful.

## Boundaries

This is process-interruption detection, exact completed-state recognition, and
explicit continuation for ambiguous states, not an atomic
transaction across Git, the document, and history. It does not automatically
complete or roll back a partially executed operation, prevent arbitrary external
writers, or guarantee directory-entry durability during sudden power loss.
External-document resolution and initial project creation are outside this
journal's scope.
Existing backup and preservation protections continue to apply to those paths.

Tests inject failures before metadata persistence and during completion for the
journaled operations, reopen the project, and verify write blocking,
preserved inventories, unchanged Git refs, stale-token rejection, retry behavior,
malformed evidence, backward-compatible version-1 records, automatic completion,
and disagreement in document, timeline, lineage, Git, recovery registry, and
recovery payload evidence. Electron coverage exercises the review, Cancel,
explicit continuation, retained-evidence deletion, and resumed editing.
