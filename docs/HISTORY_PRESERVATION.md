# History metadata preservation

Snapshot descriptions, revert lineage, timeline events, and retained recovery
point references live in `.statekeep/history.json`. Git tags alone cannot rebuild
that information. Statekeep therefore preserves an existing metadata file that
cannot be read, rather than treating it as an empty history and overwriting it.

Malformed JSON, unsupported versions, invalid records, and filesystem read
errors stop snapshot creation, revert, and recovery before those operations
flush pending edits, alter Git, replace the current document, or create/prune
recovery payloads. Existing edit history remains available. Ordinary project
editing and saving remain available.

The timeline reports the affected file and offers a review of the automatic
backup. Users can also restore a known-good file manually, or use a Statekeep
version that supports its format. Failed refreshes clear stale timeline/recovery entries
and do not display “No snapshots yet.” Restoring valid metadata makes history
operations available again without restarting the app. Statekeep does not
automatically delete or reset damaged metadata.

Lists and exports that require snapshot metadata report the same problem
instead of substituting blank descriptions or implying that context is complete.
The underlying semantic comparison remains independent of timeline metadata.

A missing metadata file without an automatic backup remains supported for legacy projects. Their snapshot
events can be synthesized from Git tags as before. An existing unreadable file
is a different condition and is never silently treated as legacy history.

## Automatic backup and explicit restore

`.statekeep/history.backup.json` holds one validated metadata copy, with its
project ID and save time. Existing readable metadata is backed up before a
history operation starts. If that backup cannot be written, the operation is
blocked before changing the project. After a successful history-operation metadata write,
the backup is refreshed to match it. First-time projects receive their first
backup when their first metadata write succeeds.

If refresh fails after the primary write, the completed operation remains a
success; the previous backup and its referenced recovery files are retained and
the failure is logged locally. Physical pruning only follows successful writes
of both primary metadata and the latest backup. Extra retained files are not
automatically reconciled or deleted by repair.

When the primary file is damaged or missing, choose **Review automatic backup**
in the snapshots panel. The preview shows the save time, counts, snapshots
absent from the backed-up timeline, and unlisted recovery files. **Restore this
backup** is a separate confirmation. Cancel leaves all files unchanged.

Restore validates the backup format, project identity, referenced Git snapshots,
and retained recovery payloads. Unsupported newer primary formats, healthy
primary metadata, and unusable backups cannot be replaced through this flow.
The preview fingerprint covers both metadata files, Git snapshot hashes, and
the recovery files; changes require a fresh preview.

Before replacement, the original bytes are copied and flushed to a unique
`history.json.damaged-*` file. If the original is missing, there is no file to
preserve. Restore leaves the current document, in-memory inventory, Undo/Redo,
Git snapshots, and recovery payloads unchanged. It clears current baseline and
pending revert lineage because a restored backup cannot establish the current
inventory's provenance. Snapshot events missing from the backup are reconstructed
from Git timestamps, with second-resolution ties placed after recorded events;
missing descriptions and exact event ordering cannot be recovered. Unlisted
recovery payloads stay on disk and are explicitly reported as outside the backup.

Restore intentionally retains the source backup unchanged, including its original
save time and lineage. The next history operation backs up the restored primary
before making changes. Preserved `history.json.damaged-*` files have no automatic
expiry; users may remove them manually after verifying recovery and retaining
any copies they need.

Metadata publication uses a flushed unique temporary file and rename. This is
one local metadata backup, not a project archive, versioned backup history, or a
transaction spanning Git, the inventory document, and all sidecars.
The containing directory is not fsynced, so a sudden power loss can still lose
the rename; file flushing alone does not guarantee crash durability.

## Review unlisted recovery files

Once history metadata is readable, **Additional recovery files → Review recovery
files** scans `.statekeep/recovery` without changing it. Each unlisted file is
shown with an eligibility explanation. Statekeep accepts recognized recovery
filenames containing a valid inventory for this project; malformed, foreign,
unsupported, oversized, linked, and unrecognized files remain untouched.
Hidden files are skipped. Each review lists at most 100 unlisted entries and
uses a 50 MB total read budget; the preview reports uninspected files rather than
silently implying they are invalid or absent.
The read budget is soft if another process grows a file during the read; actual
bytes are charged afterward and overflow is not parsed or eligible for adoption.

Choose **Review adding this file**, then **Add recovery point** to register one
eligible file. Cancel does not write metadata. Confirmation rechecks the primary
metadata bytes and file inventory/content; changed previews must be reviewed
again. Registration uses the same history-operation lock and backup gate as
snapshot operations. It leaves the inventory, Undo/Redo, timeline events, and
baseline/revert lineage unchanged and never deletes payloads.

Added recovery points have a new identity and an explicit `reconciled` reason.
Their displayed date is the registration date, not an inferred save date. Original
save time and operation context remain unknown; old timeline events are not
reattached by guessing from filenames. These points appear in a separate list
and use the existing **Recover** confirmation to replace inventory. Recovery
revalidates project identity; linked added files cannot be applied.

The ten-point automatic retention limit excludes explicitly added points.
**Remove from list → Confirm removal** unregisters an added point while keeping
its payload and past recovery events. This also works when its file is missing
or invalid, allowing future backups to stop referencing an unusable payload.
Retained files may appear in the next review. There is no file-deletion action.
History metadata version 2 records the
new reason; version 1 migrates without changing its existing records. Older
Statekeep versions will refuse the newer history metadata.

## Verification

Failure tests cover malformed JSON, future versions, invalid structures and
events. They verify unchanged metadata bytes, current document and memory,
Git snapshots, undo state, and recovery payload inventory after rejected
operations. Restoration tests verify descriptions and recovery points become
usable again. Electron coverage exercises the visible error and repair flow.

## Follow-up work

This safeguard addresses metadata that is already unreadable when an operation
starts. It does not make the current document, Git commits, and history metadata
one crash-atomic transaction. Snapshot/revert/recovery interruptions now have
[durable evidence and explicit continuation](INTERRUPTED_HISTORY.md). Automatic
completion or rollback and interruption protection for remaining metadata-only
operations remain separate work. External modification conflicts now have
[preservation and explicit resolution](EXTERNAL_DOCUMENT_CHANGES.md).

The independent Claude consultation agreed with prioritizing preservation
before archives. Validated metadata backups and explicit restore are now
implemented, along with explicit registration of valid unlisted recovery files.
Portable project archives and verified restore are now implemented; see
[Project archives](PROJECT_ARCHIVES.md) for scope, limits, and verification.
Read-only investigation with a clearly marked incomplete
metadata state should be designed alongside repair; silently dropping context
from exports is not an acceptable fallback.

Repair diagnostics should identify the offending record and field rather than
only the record category. When the first nested schema migration is added,
deep-clone its input and test that nested caller-owned records remain unchanged;
the current migration has no nested mutating steps.
