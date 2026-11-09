# Portable project archives

Choose **Archives → Export archive** in an open project. The archive captures
current inventory, including unsaved edits, and the project history needed to
continue working on another machine. Export does not create a snapshot, clear
Undo/Redo, or rewrite history metadata. Save the archive outside the project
folder. A failed export leaves any previous destination file intact.

Choose **Archives → Review archive** from the project or welcome screen. Statekeep
verifies the archive in a temporary location and shows the project name, archive
date, and snapshot/recovery counts. **Restore into a new folder** then asks for a
parent directory. A new `Statekeep-restored-*` folder is reserved atomically;
existing directories are never overwritten. Canceling the preview or folder
dialog creates no restored project. Changes to an archive after review require
another review.

Restore verifies again and removes its newly created folder if validation fails.
On success, the location is shown. Use **Open Project** to open that folder;
derived search and history indexes rebuild normally. The previously open project
remains open and unchanged. The copy retains the original project identity and
node IDs; this is a restored copy, not a fork with new identities.

## Included and excluded

The archive includes:

- Current `Statekeep.statekeep`, serialized without runtime paths/warnings.
- Git HEAD and all `snapshot/*` tags, with original commit IDs and timestamps.
- Exact bytes of `history.json`, the automatic metadata backup, and preserved
  `history.json.damaged-*` files when present.
- All regular files in `.statekeep/recovery`, including unlisted payloads.

The archive excludes derived indexes/WAL files, logs, session Undo/Redo, files
elsewhere in the project folder, and Git settings/hooks/remotes/reflogs/stashes
and other branches/tags. Git history uses a self-contained bundle rather than a
copy of `.git`; restore creates fresh local settings and a `main` branch at the
original HEAD. Bundled trees are never checked out. The index is initialized
from HEAD so the next snapshot preserves existing tracked content.

Unreadable primary history, missing referenced snapshots, and invalid or missing
registered recovery payloads block export/restore. Resolve these through metadata
restore or recovery-file reconciliation first. Backup, damaged-history, and
unlisted files are preserved as opaque bytes; their inclusion does not imply
that their contents can be used for recovery. Legacy projects with neither
primary history nor a backup remain supported.

## Format and verification

Version 1 is a JSON container named `.statekeeparchive`. It has a format marker,
format version, creation date, and an entry list. Each entry has an allowlisted
relative path, canonical base64 bytes, and a SHA-256 checksum. No general-purpose
extraction or compression is involved. Checksums detect corruption, not the
identity or trustworthiness of the archive's author.

Limits: 128 MB decoded files, 180 MB encoded container, and 2,000 entries. Git
verification also limits refs to 10,001, objects to 100,000, individual expanded
objects to 64 MB, and total stored object sizes to 256 MB; individual Git commands
have a one-minute timeout. This first
format is memory-backed and intended for bounded local projects, not large
repository archival. Source file reads have stat prechecks and actual-byte
checks; concurrent external file growth can briefly exceed a read precheck.

The decoder rejects unexpected paths, traversal, noncanonical encoding,
case-insensitive duplicates, checksum mismatches, unsupported formats, and
nonportable filenames. Source links are rejected. Restore writes regular files
only. Git runs with isolated environment/global configuration and no templates,
hooks, or checkout. Bundle prerequisites must be satisfiable in an empty repo;
Git object integrity, HEAD, snapshot documents, project identity, history
references, and registered payloads are checked. Written payloads are rehashed.
Windows recovery paths are resolved correctly on macOS/Linux as well.

Export checks history files and Git refs for external changes during capture,
then decodes and reconstructs its own output before publishing via temporary
file and rename. It captures the current in-memory inventory deliberately rather
than overwriting it with an externally edited document. It cannot repair an
inconsistent state left by an earlier interrupted multi-file operation, and does
not provide a transaction against arbitrary external writers. Directory renames
are not guaranteed durable across sudden power loss.

Verification covers real-repository round trips, unsaved inventory, snapshot
descriptions, recovery, Windows-style paths, the next snapshot, exclusions,
malformed/tampered containers, stale previews, linked payloads, failed restore
cleanup, and preservation of existing export destinations. Electron coverage
exercises export, review, cancel, and restore to a separate folder. Cross-platform
VM verification remains a release task; local tests do not claim to cover it.
