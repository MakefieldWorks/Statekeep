# Portable HTML Review

Statekeep can export a comparison as a self-contained HTML review. The file opens
in a browser without Statekeep, a network connection, JavaScript, fonts, images,
or other external resources. It can also be printed or saved as PDF through the
browser's normal print command.

The review carries the same authoritative comparison used in the app:

- snapshot names, dates, hashes, and optional descriptions
- an optional selected-subtree scope
- every prioritized review finding, without the four-card screen limit
- summary totals
- node and template changes with severity and classification
- removal cascades and broken incoming references
- before/after property, template, path, name, and order values

The report ends with a causality reminder. It describes observed differences and
user-supplied context; it does not claim that a change caused an outcome.

## Implementation

`src/shared/report.ts` builds the document as escaped, static HTML. All styling is
embedded in one `<style>` block, and the document's content security policy
denies external content. User-controlled names, paths, descriptions, and values
are HTML-escaped before interpolation.

Review findings come from `src/shared/compare-review-insights.ts`, the same pure
analysis used by the comparison panel. The panel keeps its concise four-finding
limit; HTML receives the complete finding set.

`ProjectManager.buildReport` validates the requested format and rebuilds scoped
diffs in the main process. The existing `report:export` IPC handler owns the save
dialog and file write. No renderer-provided report body reaches the filesystem.

## Verification

Unit tests cover metadata, findings, classifications, values, empty reports,
unsupported formats, and hostile HTML-like input. Electron E2E covers saving and
reading the generated `.html` file through the visible comparison action.
