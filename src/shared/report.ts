// Pure diff-report formatters: turn the existing diff output (DiffEntry[] +
// TemplateDiffEntry[]) into a shareable Markdown report or a tabular CSV. Used by
// the main-process report exporter (ProjectManager.buildReport). No filesystem,
// no Electron — deterministic given its inputs, so it is heavily unit-tested.
//
// Reuses the shared, consumer-agnostic helpers in ./diff-format. Property VALUE
// rendering is owned here (not by diff-format's UI formatValue) because a report
// must keep null / absent / empty-string distinct.

import type { ComparisonScope, DiffEntry, TemplateDiffEntry } from './types'
import { DIFF_CLASSIFICATION_LABELS, formatChangeType, formatPath, describeTemplateChange } from './diff-format'
import { ALL_REVIEW_INSIGHTS, buildReviewInsights, schemaSeverity } from './compare-review-insights'
import { serializeCsv } from './csv'

export type ReportFormat = 'markdown' | 'csv' | 'html'

export function isReportFormat(value: unknown): value is ReportFormat {
  return value === 'markdown' || value === 'csv' || value === 'html'
}

export interface ReportSnapshotMeta {
  name: string
  date: string   // human-readable (caller formats)
  hash: string   // short commit hash
  note: string | null
}

export interface ReportContext {
  projectName: string
  from: ReportSnapshotMeta
  to: ReportSnapshotMeta
  generatedAt: string
  scope?: ComparisonScope | null
  // Full old-side path ("A / B / Name") for a node id, or null if it didn't
  // exist in the old snapshot. Used to show moved nodes as old → new path.
  oldPathById: (nodeId: string) => string | null
  // Resolve a template id (old/new side) to its label for template-changed rows.
  templateLabelOld: (id: unknown) => string
  templateLabelNew: (id: unknown) => string
}

// Render a single property value so null / empty-string are not silently lost.
// (absent keys are handled by diffPropertyMaps emitting added/removed.)
function renderValue(v: unknown): string {
  if (v === null) return '(null)'
  if (v === undefined) return ''
  if (v === '') return '(empty)'
  return String(v)
}

export interface PropertyChange {
  key: string
  kind: 'added' | 'removed' | 'changed'
  old: string
  new: string
}

type PropertyValueLabels = NonNullable<DiffEntry['context']['propertyValueLabels']>
type RemovalImpact = NonNullable<DiffEntry['context']['removalImpact']>
type RemovedDescendantImpact = RemovalImpact['descendants'][number]
type IncomingReferenceImpact = RemovalImpact['incomingReferences'][number]

// Expand the whole-map oldValue/newValue of a property-changed DiffEntry into the
// per-key delta. diffProjects emits one entry per node with both full maps, so the
// report must compute which keys actually changed.
export function diffPropertyMaps(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  labels: PropertyValueLabels = {},
): PropertyChange[] {
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort()
  const out: PropertyChange[] = []
  for (const key of keys) {
    const inBefore = key in before
    const inAfter = key in after
    const oldValue = labels[key]?.old ?? renderValue(before[key])
    const newValue = labels[key]?.new ?? renderValue(after[key])
    if (inBefore && !inAfter) out.push({ key, kind: 'removed', old: oldValue, new: '' })
    else if (!inBefore && inAfter) out.push({ key, kind: 'added', old: '', new: newValue })
    else if (before[key] !== after[key]) out.push({ key, kind: 'changed', old: oldValue, new: newValue })
  }
  return out
}

function propsOf(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>
}

function byType(diffs: DiffEntry[], type: DiffEntry['changeType']): DiffEntry[] {
  return diffs.filter(d => d.changeType === type)
}

function ancestorPath(entry: DiffEntry): string {
  return entry.context.path.join(' / ')
}

function fullPath(entry: DiffEntry): string {
  return formatPath(entry.context.path, entry.context.nodeName)
}

function removalImpact(entry: DiffEntry): RemovalImpact | undefined {
  const impact = entry.context.removalImpact
  if (!impact) return undefined
  if (impact.descendants.length === 0 && impact.incomingReferences.length === 0) return undefined
  return impact
}

function descendantLabel(descendant: RemovedDescendantImpact): string {
  return formatPath(descendant.path, descendant.name)
}

function incomingReferenceLabel(reference: IncomingReferenceImpact): string {
  return `${formatPath(reference.path, reference.nodeName)} (${reference.fieldKey})`
}

function joinedImpactLabels(values: string[]): string {
  return values.join(' | ')
}

function csvContext(value: string | null): string {
  return value?.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim() ?? ''
}

function snapshotMetaDetails(meta: ReportSnapshotMeta): string {
  return [meta.date, meta.hash].filter(Boolean).join(' · ')
}

// Neutralize Markdown-significant content in an interpolated value so a node name
// or property value (which may contain newlines or markup — validateNodeName only
// rejects slashes, and property values are free-form) can't corrupt the report
// structure. CR/LF/tab collapse to a space (no injected headings or list items);
// inline emphasis / code / link / HTML characters are backslash-escaped. The CSV
// path is handled separately by serializeCsv (quoting + formula escaping).
//
// SCOPE: this is for INLINE / list-item contexts only. It deliberately does not
// escape line-start block markers (#, -, +, >, |) because CR/LF are already
// collapsed to spaces, so an interpolated value can never start a line. If a
// future section interpolates values into a Markdown TABLE, add '|' to the
// escape set first — otherwise an embedded pipe would break table columns.
function md(value: unknown): string {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .replace(/[\\`*_[\]<>]/g, '\\$&')
}

// ─── Markdown ───────────────────────────────────────────────────────────────

export function formatDiffReportMarkdown(
  diffs: DiffEntry[],
  templateDiffs: TemplateDiffEntry[],
  ctx: ReportContext,
): string {
  const added = byType(diffs, 'added')
  const removed = byType(diffs, 'removed')
  const renamed = byType(diffs, 'renamed')
  const moved = byType(diffs, 'moved')
  const propChanged = byType(diffs, 'property-changed')
  const tplChanged = byType(diffs, 'template-changed')
  const orderChanged = byType(diffs, 'order-changed')

  const lines: string[] = []
  lines.push(`# Change Report: ${md(ctx.projectName)}`)
  lines.push('')
  const fromDetails = snapshotMetaDetails(ctx.from)
  const toDetails = snapshotMetaDetails(ctx.to)
  lines.push(`**From:** ${md(ctx.from.name)}${fromDetails ? ` (${md(fromDetails)})` : ''}  `)
  if (ctx.from.note) lines.push(`**From description:** ${md(ctx.from.note)}  `)
  lines.push(`**To:** ${md(ctx.to.name)}${toDetails ? ` (${md(toDetails)})` : ''}  `)
  if (ctx.to.note) lines.push(`**To description:** ${md(ctx.to.note)}  `)
  if (ctx.scope) lines.push(`**Scope:** ${md(ctx.scope.path)}  `)
  lines.push(`**Generated:** ${md(ctx.generatedAt)}`)
  lines.push('')

  if (diffs.length === 0 && templateDiffs.length === 0) {
    lines.push(`No changes between ${md(ctx.from.name)} and ${md(ctx.to.name)}.`)
    lines.push('')
    return lines.join('\n')
  }

  lines.push('## Summary')
  lines.push(`- Added: ${added.length}`)
  lines.push(`- Removed: ${removed.length}`)
  lines.push(`- Renamed: ${renamed.length}`)
  lines.push(`- Moved: ${moved.length}`)
  lines.push(`- Property changes: ${propChanged.length} node(s)`)
  lines.push(`- Template changes: ${tplChanged.length}`)
  lines.push(`- Order changes: ${orderChanged.length}`)
  lines.push(`- Schema changes: ${templateDiffs.length}`)
  const removedWithBrokenReferences = removed
    .filter(e => (e.context.removalImpact?.incomingReferences.length ?? 0) > 0)
    .length
  if (removedWithBrokenReferences > 0) {
    lines.push(`- Removed nodes with broken references: ${removedWithBrokenReferences}`)
  }
  lines.push('')

  if (added.length > 0) {
    lines.push(`## Added (${added.length})`)
    for (const e of added) lines.push(`- ${md(fullPath(e))}`)
    lines.push('')
  }
  if (removed.length > 0) {
    lines.push(`## Removed (${removed.length})`)
    for (const e of removed) {
      lines.push(`- ${md(fullPath(e))}`)
      const impact = removalImpact(e)
      if (impact?.descendants.length) {
        lines.push(`  - Descendants also removed (${impact.descendants.length}): ${impact.descendants.map(d => md(descendantLabel(d))).join(', ')}`)
      }
      if (impact?.incomingReferences.length) {
        lines.push(`  - Incoming references broken (${impact.incomingReferences.length}): ${impact.incomingReferences.map(r => md(incomingReferenceLabel(r))).join(', ')}`)
      }
    }
    lines.push('')
  }
  if (renamed.length > 0) {
    lines.push(`## Renamed (${renamed.length})`)
    for (const e of renamed) {
      const where = md(ancestorPath(e))
      const prefix = where ? `${where} / ` : ''
      lines.push(`- ${prefix}"${md(e.oldValue)}" → "${md(e.newValue)}"`)
    }
    lines.push('')
  }
  if (moved.length > 0) {
    lines.push(`## Moved (${moved.length})`)
    for (const e of moved) {
      const resolved = ctx.oldPathById(e.nodeId)
      const oldP = resolved !== null ? md(resolved) : `"${md(e.context.nodeName)}"`
      lines.push(`- ${oldP} → ${md(fullPath(e))}`)
    }
    lines.push('')
  }
  if (propChanged.length > 0) {
    lines.push(`## Property changes (${propChanged.length} node(s))`)
    for (const e of propChanged) {
      lines.push(`- ${md(fullPath(e))}`)
      for (const pc of diffPropertyMaps(propsOf(e.oldValue), propsOf(e.newValue), e.context.propertyValueLabels)) {
        if (pc.kind === 'added') lines.push(`  - + ${md(pc.key)}: ${md(pc.new)}`)
        else if (pc.kind === 'removed') lines.push(`  - − ${md(pc.key)} (was ${md(pc.old)})`)
        else lines.push(`  - ${md(pc.key)}: ${md(pc.old)} → ${md(pc.new)}`)
      }
    }
    lines.push('')
  }
  if (tplChanged.length > 0) {
    lines.push(`## Template changes (${tplChanged.length})`)
    for (const e of tplChanged) {
      lines.push(`- ${md(fullPath(e))}: ${md(ctx.templateLabelOld(e.oldValue))} → ${md(ctx.templateLabelNew(e.newValue))}`)
    }
    lines.push('')
  }
  if (orderChanged.length > 0) {
    lines.push(`## Order changes (${orderChanged.length})`)
    for (const e of orderChanged) {
      lines.push(`- ${md(fullPath(e))}: ${md(e.oldValue)} → ${md(e.newValue)}`)
    }
    lines.push('')
  }
  if (templateDiffs.length > 0) {
    lines.push(`## Schema changes (${templateDiffs.length})`)
    for (const t of templateDiffs) lines.push(`- ${md(describeTemplateChange(t))}`)
    lines.push('')
  }

  return lines.join('\n')
}

// ─── Self-contained HTML ───────────────────────────────────────────────────

function html(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const HTML_SEVERITY_CLASSES: Record<DiffEntry['severity'], string> = {
  High: 'severity-high',
  Medium: 'severity-medium',
  Low: 'severity-low',
}

const HTML_SEVERITY_BORDER_CLASSES: Record<DiffEntry['severity'], string> = {
  High: 'severity-border-high',
  Medium: 'severity-border-medium',
  Low: 'severity-border-low',
}

function htmlBadges(entry: DiffEntry): string {
  return `<span class="badge ${HTML_SEVERITY_CLASSES[entry.severity]}">${html(entry.severity)}</span>` +
    `<span class="badge classification">${html(DIFF_CLASSIFICATION_LABELS[entry.classification])}</span>`
}

function htmlChangeItem(entry: DiffEntry, body = ''): string {
  return `<article class="change-card"><div class="change-heading"><div>` +
    `<h3>${html(fullPath(entry))}</h3><p>${html(formatChangeType(entry.changeType))}</p>` +
    (entry.severityReason ? `<p class="severity-reason">${html(entry.severityReason)}</p>` : '') + `</div>` +
    `<div class="badges">${htmlBadges(entry)}</div></div>${body}</article>`
}

function htmlSection(title: string, items: string[]): string {
  if (items.length === 0) return ''
  return `<section><div class="section-heading"><h2>${html(title)}</h2><span>${items.length}</span></div>` +
    `<div class="change-list">${items.join('')}</div></section>`
}

function htmlValueDelta(oldValue: string, newValue: string): string {
  return `<span class="old-value">${html(oldValue || '—')}</span><span class="arrow">→</span>` +
    `<span class="new-value">${html(newValue || '—')}</span>`
}

export function formatDiffReportHtml(
  diffs: DiffEntry[],
  templateDiffs: TemplateDiffEntry[],
  ctx: ReportContext,
): string {
  const counts = {
    Added: byType(diffs, 'added').length,
    Removed: byType(diffs, 'removed').length,
    Renamed: byType(diffs, 'renamed').length,
    Moved: byType(diffs, 'moved').length,
    'Property changes': byType(diffs, 'property-changed').length,
    'Template changes': byType(diffs, 'template-changed').length,
    'Order changes': byType(diffs, 'order-changed').length,
    'Schema changes': templateDiffs.length,
  }
  const insights = buildReviewInsights(diffs, templateDiffs, { limit: ALL_REVIEW_INSIGHTS })
  const findings = insights.length === 0 ? '' : `<section><div class="section-heading"><h2>Review findings</h2><span>${insights.length}</span></div>` +
    `<div class="finding-list">${insights.map(insight => {
      return `<article class="finding ${HTML_SEVERITY_BORDER_CLASSES[insight.severity]}"><div class="badges">` +
        `<span class="badge ${HTML_SEVERITY_CLASSES[insight.severity]}">${html(insight.severity)}</span>` +
        `<span class="badge classification">${html(DIFF_CLASSIFICATION_LABELS[insight.classification])}</span></div>` +
        `<h3>${html(insight.label)}</h3><p>${html(insight.detail)}</p></article>`
    }).join('')}</div></section>`

  const added = byType(diffs, 'added').map(entry => htmlChangeItem(entry))
  const removed = byType(diffs, 'removed').map(entry => {
    const impact = removalImpact(entry)
    const details = impact ? `<div class="impact">` +
      (impact.descendants.length > 0
        ? `<p><strong>Descendants also removed:</strong> ${html(impact.descendants.map(descendantLabel).join(', '))}</p>`
        : '') +
      (impact.incomingReferences.length > 0
        ? `<p><strong>Incoming references broken:</strong> ${html(impact.incomingReferences.map(incomingReferenceLabel).join(', '))}</p>`
        : '') + `</div>` : ''
    return htmlChangeItem(entry, details)
  })
  const renamed = byType(diffs, 'renamed').map(entry => htmlChangeItem(
    entry,
    `<div class="delta">${htmlValueDelta(String(entry.oldValue ?? ''), String(entry.newValue ?? ''))}</div>`,
  ))
  const moved = byType(diffs, 'moved').map(entry => htmlChangeItem(
    entry,
    `<div class="delta">${htmlValueDelta(ctx.oldPathById(entry.nodeId) ?? entry.context.nodeName, fullPath(entry))}</div>`,
  ))
  const propertyChanges = byType(diffs, 'property-changed').map(entry => {
    const rows = diffPropertyMaps(propsOf(entry.oldValue), propsOf(entry.newValue), entry.context.propertyValueLabels)
      .map(change => `<div class="property-row"><strong>${html(change.key)}</strong>` +
        `<span class="property-kind">${html(change.kind)}</span><span class="delta">${htmlValueDelta(change.old, change.new)}</span></div>`)
      .join('')
    return htmlChangeItem(entry, `<div class="property-list">${rows}</div>`)
  })
  const templateChanges = byType(diffs, 'template-changed').map(entry => htmlChangeItem(
    entry,
    `<div class="delta">${htmlValueDelta(ctx.templateLabelOld(entry.oldValue), ctx.templateLabelNew(entry.newValue))}</div>`,
  ))
  const orderChanges = byType(diffs, 'order-changed').map(entry => htmlChangeItem(
    entry,
    `<div class="delta">${htmlValueDelta(String(entry.oldValue ?? ''), String(entry.newValue ?? ''))}</div>`,
  ))
  const schemaChanges = templateDiffs.map(change => {
    const severity = schemaSeverity([change])
    return `<article class="change-card"><div class="change-heading"><div>` +
      `<h3>${html(change.templateLabel || change.templateId)}</h3><p>${html(describeTemplateChange(change))}</p></div>` +
      `<div class="badges"><span class="badge ${HTML_SEVERITY_CLASSES[severity]}">${html(severity)}</span>` +
      `<span class="badge classification">Schema</span></div></div></article>`
  })

  const changeSections = [
    htmlSection('Added', added),
    htmlSection('Removed', removed),
    htmlSection('Renamed', renamed),
    htmlSection('Moved', moved),
    htmlSection('Property changes', propertyChanges),
    htmlSection('Template changes', templateChanges),
    htmlSection('Order changes', orderChanges),
    htmlSection('Schema changes', schemaChanges),
  ].join('')
  const hasChanges = diffs.length > 0 || templateDiffs.length > 0
  const summary = hasChanges
    ? `<section><div class="section-heading"><h2>Summary</h2><span>${diffs.length + templateDiffs.length} total</span></div><div class="summary-grid">${Object.entries(counts).map(([label, count]) => `<div class="summary"><span>${html(label)}</span><strong>${count}</strong></div>`).join('')}</div></section>`
    : ''
  const empty = !hasChanges
    ? `<section class="empty"><h2>No changes</h2><p>No changes between ${html(ctx.from.name)} and ${html(ctx.to.name)}.</p></section>`
    : ''
  const fromDetails = snapshotMetaDetails(ctx.from)
  const toDetails = snapshotMetaDetails(ctx.to)

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>Change Report: ${html(ctx.projectName)}</title>
  <style>
    :root { color-scheme: light; --ink:#1c1917; --muted:#78716c; --line:#e7e5e4; --paper:#fff; --wash:#f5f5f4; --accent:#4f46e5; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--wash); color:var(--ink); font:14px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(1040px,calc(100% - 32px)); margin:32px auto; }
    header, section, footer { background:var(--paper); border:1px solid var(--line); border-radius:14px; padding:24px; margin-bottom:18px; }
    header { border-top:5px solid var(--accent); }
    h1,h2,h3,p { margin-top:0; } h1 { font-size:28px; margin-bottom:4px; } h2 { font-size:18px; margin:0; } h3 { font-size:14px; margin:0; }
    .eyebrow { color:var(--accent); font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
    .subtitle { color:var(--muted); margin-bottom:20px; }
    .meta-grid,.summary-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; }
    .meta,.summary { background:var(--wash); border-radius:10px; padding:12px 14px; }
    .meta span,.summary span { display:block; color:var(--muted); font-size:11px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; }
    .meta strong,.summary strong { display:block; margin-top:3px; overflow-wrap:anywhere; }
    .description { color:#44403c; margin:6px 0 0; white-space:normal; }
    .scope { margin-top:14px; color:#5b21b6; font-weight:650; }
    .section-heading { display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--line); padding-bottom:12px; margin-bottom:14px; }
    .section-heading span { color:var(--muted); font-variant-numeric:tabular-nums; }
    .finding-list,.change-list { display:grid; gap:10px; }
    .finding,.change-card { border:1px solid var(--line); border-radius:10px; padding:14px; break-inside:avoid; }
    .finding { border-left-width:4px; } .finding h3 { margin:8px 0 3px; } .finding p,.change-heading p { color:var(--muted); margin:0; }
    .change-heading .severity-reason { margin-top:4px; color:#57534e; }
    .severity-border-high { border-left-color:#b91c1c; } .severity-border-medium { border-left-color:#b45309; } .severity-border-low { border-left-color:#047857; }
    .change-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
    .badges { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
    .badge { border-radius:999px; padding:2px 8px; font-size:11px; font-weight:700; white-space:nowrap; }
    .severity-high { background:#fee2e2; color:#991b1b; } .severity-medium { background:#fef3c7; color:#92400e; } .severity-low { background:#d1fae5; color:#065f46; }
    .classification { background:#e7e5e4; color:#44403c; }
    .delta { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:10px; }
    .old-value,.new-value { background:var(--wash); border-radius:6px; padding:3px 7px; overflow-wrap:anywhere; }
    .old-value { color:#9f1239; } .new-value { color:#166534; } .arrow { color:var(--muted); }
    .impact,.property-list { border-top:1px solid var(--line); margin-top:12px; padding-top:10px; }
    .impact p { margin:4px 0; }
    .property-row { display:grid; grid-template-columns:minmax(120px,1fr) auto minmax(220px,2fr); gap:10px; align-items:center; padding:7px 0; border-bottom:1px solid var(--line); }
    .property-row:last-child { border-bottom:0; } .property-kind { color:var(--muted); font-size:12px; }
    .empty { text-align:center; } .empty h2 { margin-bottom:4px; } .empty p { color:var(--muted); margin:0; }
    footer { color:var(--muted); font-size:12px; }
    @media (max-width:640px) { main { width:min(100% - 20px,1040px); margin:10px auto; } header,section,footer { padding:16px; } .property-row { grid-template-columns:1fr; } }
    @media print { * { print-color-adjust:exact; -webkit-print-color-adjust:exact; } body { background:#fff; } main { width:100%; margin:0; } header,section,footer { box-shadow:none; } }
  </style>
</head>
<body><main>
  <header>
    <p class="eyebrow">Statekeep change review</p>
    <h1>${html(ctx.projectName)}</h1>
    <p class="subtitle">A portable review of observed project changes.</p>
    <div class="meta-grid">
      <div class="meta"><span>From</span><strong>${html(ctx.from.name)}</strong>${fromDetails ? `<p>${html(fromDetails)}</p>` : ''}${ctx.from.note ? `<p class="description">${html(ctx.from.note)}</p>` : ''}</div>
      <div class="meta"><span>To</span><strong>${html(ctx.to.name)}</strong>${toDetails ? `<p>${html(toDetails)}</p>` : ''}${ctx.to.note ? `<p class="description">${html(ctx.to.note)}</p>` : ''}</div>
      <div class="meta"><span>Generated</span><strong>${html(ctx.generatedAt)}</strong></div>
    </div>
    ${ctx.scope ? `<p class="scope">Scope: ${html(ctx.scope.path)}</p>` : ''}
  </header>
  ${findings}
  ${summary}${empty}${changeSections}
  <footer>This report describes observed differences and user-supplied context. It does not establish that a change caused an outcome.</footer>
</main></body>
</html>`
}

// ─── CSV (node changes only; one row per change, property-changes expanded) ───

const CSV_HEADER = [
  'path', 'node', 'change', 'severity', 'property', 'old', 'new',
  'removed_descendants', 'broken_references', 'from_description', 'to_description', 'scope',
]

// CSV carries node changes only (schema detail lives in the Markdown report). But
// it must never read as "no changes" when a schema-only diff happened — so a
// single notice row records that schema changes exist and where to find them.
export function formatDiffReportCsv(
  diffs: DiffEntry[],
  templateDiffs: TemplateDiffEntry[],
  ctx: ReportContext,
): string {
  const rows: string[][] = [CSV_HEADER]
  const context = [csvContext(ctx.from.note), csvContext(ctx.to.note), csvContext(ctx.scope?.path ?? null)]

  if (templateDiffs.length > 0) {
    const n = templateDiffs.length
    rows.push(['', '(schema changes)', 'schema-change', '', '', '', `${n} schema change${n === 1 ? '' : 's'} — see the Markdown report for detail`, '', '', ...context])
  }

  for (const e of diffs) {
    const path = ancestorPath(e)
    const node = e.context.nodeName
    const base = (change: string, property: string, oldV: string, newV: string): string[] =>
      [path, node, change, e.severity, property, oldV, newV, '', '', ...context]

    switch (e.changeType) {
      case 'added':
        rows.push(base(e.changeType, '', '', ''))
        break
      case 'removed':
        {
          const impact = removalImpact(e)
          rows.push([
            path,
            node,
            e.changeType,
            e.severity,
            '',
            '',
            '',
            joinedImpactLabels(impact?.descendants.map(descendantLabel) ?? []),
            joinedImpactLabels(impact?.incomingReferences.map(incomingReferenceLabel) ?? []),
            ...context,
          ])
        }
        break
      case 'renamed':
        rows.push(base('renamed', '', String(e.oldValue ?? ''), String(e.newValue ?? '')))
        break
      case 'moved':
        rows.push(base('moved', '', ctx.oldPathById(e.nodeId) ?? '', fullPath(e)))
        break
      case 'template-changed':
        rows.push(base('template-changed', '', ctx.templateLabelOld(e.oldValue), ctx.templateLabelNew(e.newValue)))
        break
      case 'order-changed':
        rows.push(base('order-changed', '', String(e.oldValue ?? ''), String(e.newValue ?? '')))
        break
      case 'property-changed':
        for (const pc of diffPropertyMaps(propsOf(e.oldValue), propsOf(e.newValue), e.context.propertyValueLabels)) {
          rows.push(base(`property-${pc.kind}`, pc.key, pc.old, pc.new))
        }
        break
    }
  }

  return serializeCsv(rows)
}
