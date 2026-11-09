// The project document on disk: parse, validate, serialize, hash, and the
// non-fatal warnings surfaced on open. Pure functions plus bounded reads; no
// in-memory project state lives here (ProjectManager owns that).

import { lstatSync, readFileSync } from 'fs'
import { createHash } from 'crypto'
import type { ProjectNode, DocumentWarning, NodeTemplate, Project, ProjectWarning, Result } from '../../shared/types'
import { ok, err, ErrorCode } from '../../shared/errors'
import { migrate } from '../../shared/migration'
import {
  validateTemplate,
  validateTemplateId,
  validateTypedPropertyValue,
  validateReferenceTarget,
  templateFields,
} from '../../shared/validation'
import { detectCloudSyncPath } from '../../shared/cloud-sync'
import type { Logger } from '../logger'

export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024  // 50 MB
export const MAX_FILE_SIZE_MB = MAX_FILE_SIZE_BYTES / 1024 / 1024

export function hashDocument(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// Strip runtime-only fields (path, warnings) before writing or hashing.
export function serializeProjectForPersistence(project: Project): string {
  const { path: _path, loadWarnings: _loadWarnings, projectWarnings: _projectWarnings, ...persistable } = project
  return JSON.stringify(persistable, null, 2)
}

export function canonicalizeDocumentJson(raw: string): string {
  return JSON.stringify(JSON.parse(raw), null, 2)
}

// Read a project document's bytes, refusing links, non-files, and oversize
// files. Returns null only when the file does not exist.
export function readDocumentBytes(path: string): Buffer | null {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_SIZE_BYTES) throw new Error('The project file is linked, not a regular file, or exceeds 50 MB.')
    const bytes = readFileSync(path)
    if (bytes.length > MAX_FILE_SIZE_BYTES) throw new Error('The project file exceeds 50 MB.')
    return bytes
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function readDocumentHash(path: string): string | null {
  const bytes = readDocumentBytes(path)
  return bytes === null ? null : hashDocument(bytes)
}

// JSON → migrated → structurally validated Project.
export function parseProjectDocument(raw: string, logger: Logger): Result<Project> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any

  try {
    data = JSON.parse(raw)
  } catch {
    return err(ErrorCode.VALIDATION_FAILED, 'Project file is not valid JSON')
  }

  try {
    data = migrate(data)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return err(ErrorCode.SCHEMA_VERSION, msg)
  }

  const validation = validateProjectDocument(data, logger)
  if (!validation.ok) return validation as Result<Project>

  return ok(data as Project)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function validateProjectDocument(data: any, logger: Logger): Result<void> {
  if (!data.id || typeof data.id !== 'string') {
    return err(ErrorCode.VALIDATION_FAILED, 'Missing required field: id')
  }
  if (!data.name || typeof data.name !== 'string') {
    return err(ErrorCode.VALIDATION_FAILED, 'Missing required field: name')
  }
  if (!Array.isArray(data.nodes)) {
    return err(ErrorCode.VALIDATION_FAILED, 'Missing required field: nodes')
  }

  const ids = new Set<string>()
  for (const node of data.nodes as ProjectNode[]) {
    if (!node.id || !node.name || node.order === undefined || node.order === null) {
      return err(ErrorCode.VALIDATION_FAILED, 'Node missing required fields (id/name/order)')
    }
    if (ids.has(node.id)) {
      logger.warn('duplicate node ID detected', { id: node.id })
    }
    ids.add(node.id)
  }

  // Exactly one root node required (v2+).
  const roots = (data.nodes as ProjectNode[]).filter(n => n.parentId === null)
  if (roots.length !== 1) {
    return err(
      ErrorCode.INVALID_HIERARCHY,
      `Expected exactly one root node, found ${roots.length}`
    )
  }

  if (hasCircularRefs(data.nodes)) {
    return err(ErrorCode.INVALID_HIERARCHY, 'Project contains circular parent references')
  }

  return ok(undefined as void)
}

// Collect non-fatal, path-qualified warnings about template integrity and
// typed-value mismatches. NEVER mutates or coerces — values are left exactly
// as written on disk; the app surfaces these to the user.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function collectLoadWarnings(data: any): DocumentWarning[] {
  const warnings: DocumentWarning[] = []
  const templates: Record<string, NodeTemplate> =
    data.templates && typeof data.templates === 'object' ? data.templates : {}
  const nodes = (data.nodes ?? []) as ProjectNode[]

  // Structurally invalid template definitions.
  for (const [id, template] of Object.entries(templates)) {
    const idCheck = validateTemplateId(id)
    if (!idCheck.valid) {
      warnings.push({
        path: `templates.${id}`,
        code: 'INVALID_TEMPLATE_ID',
        message: idCheck.message ?? 'Invalid template id',
      })
      continue
    }
    const tplCheck = validateTemplate(template as NodeTemplate)
    if (!tplCheck.valid) {
      warnings.push({
        path: `templates.${id}`,
        code: 'INVALID_TEMPLATE',
        message: tplCheck.message ?? 'Invalid template',
      })
      continue
    }
    for (const [key, field] of Object.entries(templateFields(template as NodeTemplate))) {
      if (field.type !== 'reference' || field.default === undefined || field.default === null) {
        continue
      }
      const targetCheck = validateReferenceTarget(field.default, nodes)
      if (!targetCheck.valid) {
        warnings.push({
          path: `templates.${id}.fields.${key}.default`,
          code: 'INVALID_REFERENCE',
          message: `${targetCheck.message} (got ${JSON.stringify(field.default)})`,
        })
      }
    }
  }

  // Per-node: dangling templateId and typed-value mismatches.
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const templateId = node.templateId ?? null
    if (templateId === null) continue

    const template = templates[templateId]
    if (!template) {
      warnings.push({
        path: `nodes[${i}].templateId`,
        code: 'TEMPLATE_NOT_FOUND',
        message: `Node references unknown template "${templateId}"`,
      })
      continue
    }

    // The referenced template may itself be structurally invalid (already
    // warned above). templateFields() is null-safe, so we never throw on a
    // missing/non-iterable `fields` — load stays non-fatal.
    const props = node.properties ?? {}
    for (const [key, field] of Object.entries(templateFields(template))) {
      const value = props[key]
      if (value === undefined || value === null || value === '') {
        // A required field that has no value is a (non-fatal) integrity
        // warning — this gives the `required` flag a real, surfaced meaning
        // without hard-blocking edits.
        if (field.required) {
          warnings.push({
            path: `nodes[${i}].properties.${key}`,
            code: 'MISSING_REQUIRED',
            message: `Required field "${key}" is not set`,
          })
        }
        continue
      }
      const check = validateTypedPropertyValue(value, field)
      if (!check.valid) {
        warnings.push({
          path: `nodes[${i}].properties.${key}`,
          code: 'INVALID_TYPED_VALUE',
          message: `${check.message} (got ${JSON.stringify(value)})`,
        })
        continue
      }
      const targetCheck = field.type === 'reference'
        ? validateReferenceTarget(value, nodes, node.id)
        : { valid: true }
      if (!targetCheck.valid) {
        warnings.push({
          path: `nodes[${i}].properties.${key}`,
          code: 'INVALID_REFERENCE',
          message: `${targetCheck.message} (got ${JSON.stringify(value)})`,
        })
      }
    }
  }

  return warnings
}

export function collectProjectWarnings(projectPath: string): ProjectWarning[] {
  const cloudPath = detectCloudSyncPath(projectPath)
  if (!cloudPath) return []

  return [{
    code: 'CLOUD_SYNC_PROJECT',
    title: `Project is inside ${cloudPath.provider}`,
    message: 'Cloud sync can corrupt Statekeep search/history indexes because SQLite WAL files must stay in lockstep. Keep Statekeep projects in a local folder and back up/export snapshots separately.',
    provider: cloudPath.provider,
    path: projectPath,
  }]
}

export function withProjectWarnings(project: Project, projectWarnings: ProjectWarning[]): Project {
  if (projectWarnings.length === 0) return project
  return {
    ...project,
    projectWarnings,
  }
}

export function withLoadWarnings(project: Project, loadWarnings: DocumentWarning[]): Project {
  if (loadWarnings.length === 0) return project
  return {
    ...project,
    loadWarnings,
  }
}

function hasCircularRefs(nodes: ProjectNode[]): boolean {
  const parentMap = new Map<string, string | null>()
  for (const node of nodes) {
    parentMap.set(node.id, node.parentId ?? null)
  }
  for (const node of nodes) {
    const visited = new Set<string>()
    let current: string | null = node.id
    while (current !== null) {
      if (visited.has(current)) return true
      visited.add(current)
      current = parentMap.get(current) ?? null
    }
  }
  return false
}
