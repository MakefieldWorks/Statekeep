import { existsSync } from 'fs'
import { isAbsolute, join } from 'path'
import { err, ErrorCode, ok } from '../shared/errors'
import { PROJECT_STARTERS, type ProjectStarterId } from '../shared/project-starters'
import type { NodeTemplate, Project, Result } from '../shared/types'
import { validateProjectDirectoryName } from '../shared/validation'
import type { ProjectManager } from './project-manager'

type Values = Record<string, string | number | boolean | null>
interface StarterNode { key: string; parent?: string; name: string; template: string; properties: Values }
interface StarterDefinition { templates: Record<string, NodeTemplate>; nodes: StarterNode[]; update: { key: string; properties: Values }; addition: StarterNode; note: string }
const location: NodeTemplate = { label: 'Location', fields: { purpose: { type: 'string' } } }
const device: NodeTemplate = { label: 'Device', fields: { serial: { type: 'string', required: true }, firmware: { type: 'version' }, owner: { type: 'string' }, inService: { type: 'boolean' } } }

/** Catalog format v1. Parent keys must precede children; all values use normal project validation. */
export const STARTER_DEFINITIONS: Record<ProjectStarterId, StarterDefinition> = {
  lab: {
    templates: { location, instrument: { label: 'Instrument', fields: { serial: { type: 'string', required: true }, firmware: { type: 'version' }, calibrationDue: { type: 'date' }, channels: { type: 'number' } } } },
    nodes: [
      { key: 'room', name: 'Systems Room', template: 'location', properties: { purpose: 'Integration testing' } },
      { key: 'rack', parent: 'room', name: 'Rack A', template: 'location', properties: { purpose: 'Measurement equipment' } },
      { key: 'instrument', parent: 'rack', name: 'Signal Analyzer', template: 'instrument', properties: { serial: 'DEMO-SA-042', firmware: '1.3.0', calibrationDue: '2027-06-01', channels: 4 } },
    ],
    update: { key: 'instrument', properties: { serial: 'DEMO-SA-042', firmware: '1.4.0', calibrationDue: '2027-06-01', channels: 4 } },
    addition: { key: 'scope', parent: 'rack', name: 'Oscilloscope', template: 'instrument', properties: { serial: 'DEMO-OSC-017', firmware: '2.1.0', calibrationDue: '2027-09-01', channels: 2 } },
    note: 'Updated analyzer firmware and added an oscilloscope for validation.',
  },
  network: {
    templates: { location, device },
    nodes: [
      { key: 'site', name: 'Main Office', template: 'location', properties: { purpose: 'Office network' } },
      { key: 'rack', parent: 'site', name: 'Network Rack', template: 'location', properties: { purpose: 'Distribution equipment' } },
      { key: 'switch', parent: 'rack', name: 'Core Switch', template: 'device', properties: { serial: 'DEMO-SW-001', firmware: '4.2.0', owner: 'Network team', inService: true } },
    ],
    update: { key: 'switch', properties: { serial: 'DEMO-SW-001', firmware: '4.3.0', owner: 'Network team', inService: true } },
    addition: { key: 'access', parent: 'rack', name: 'Access Switch', template: 'device', properties: { serial: 'DEMO-SW-002', firmware: '4.3.0', owner: 'Network team', inService: true } },
    note: 'Upgraded the core switch and added an access switch.',
  },
  maintenance: {
    templates: { location, asset: { label: 'Serviceable asset', fields: { serial: { type: 'string', required: true }, lastService: { type: 'date' }, status: { type: 'enum', options: ['operational', 'service-due'] }, hours: { type: 'number' } } } },
    nodes: [
      { key: 'workshop', name: 'Workshop', template: 'location', properties: { purpose: 'Equipment maintenance' } },
      { key: 'equipment', parent: 'workshop', name: 'Air Compressor', template: 'asset', properties: { serial: 'DEMO-AC-009', lastService: '2026-03-01', status: 'service-due', hours: 1200 } },
      { key: 'filter', parent: 'equipment', name: 'Intake Filter', template: 'asset', properties: { serial: 'DEMO-F-001', lastService: '2026-03-01', status: 'service-due', hours: 1200 } },
    ],
    update: { key: 'filter', properties: { serial: 'DEMO-F-001', lastService: '2026-11-01', status: 'operational', hours: 0 } },
    addition: { key: 'belt', parent: 'equipment', name: 'Spare Drive Belt', template: 'asset', properties: { serial: 'DEMO-B-002', lastService: '2026-11-01', status: 'operational', hours: 0 } },
    note: 'Serviced the intake filter and recorded a spare drive belt.',
  },
}

async function createStarterProjectUnchecked(manager: ProjectManager, request: unknown): Promise<Result<Project>> {
  if (!request || typeof request !== 'object') return err(ErrorCode.VALIDATION_FAILED, 'Choose a starter, name, and location.')
  const { starterId, name, parentPath } = request as Record<string, unknown>
  const metadata = PROJECT_STARTERS.find(starter => starter.id === starterId)
  if (!metadata || typeof name !== 'string' || !validateProjectDirectoryName(name).valid || typeof parentPath !== 'string' || !isAbsolute(parentPath)) {
    return err(ErrorCode.VALIDATION_FAILED, 'Choose a valid starter, project name, and absolute destination folder.')
  }
  if (manager.getCurrent()) return err(ErrorCode.VALIDATION_FAILED, 'Close the current project before creating a starter.')
  if (existsSync(join(parentPath, name))) return err(ErrorCode.PROJECT_EXISTS, 'The destination already exists. Choose another project name or location.')
  const definition = STARTER_DEFINITIONS[metadata.id]
  const created = await manager.createProject(name, parentPath)
  if (!created.ok) return created
  const ids = new Map<string, string>([['root', created.data.nodes[0]!.id]])
  for (const [id, template] of Object.entries(definition.templates)) {
    const result = manager.templateCreate(id, structuredClone(template))
    if (!result.ok) return result
  }
  const addNode = (node: StarterNode): Result<Project> => {
    const parentId = ids.get(node.parent ?? 'root')
    if (!parentId) return err(ErrorCode.INVALID_HIERARCHY, 'Starter parent not found.')
    const before = new Set(manager.getCurrent()!.nodes.map(item => item.id))
    const result = manager.nodeCreate(parentId, node.name, node.template)
    if (!result.ok) return result
    const added = result.data.nodes.find(item => !before.has(item.id))!
    ids.set(node.key, added.id)
    return manager.nodeUpdate(added.id, { properties: { ...node.properties } })
  }
  for (const node of definition.nodes) { const result = addNode(node); if (!result.ok) return result }
  const baseline = await manager.snapshotCreate('baseline', `Fictional ${metadata.name} starting configuration. ${metadata.exercise}`)
  if (!baseline.ok) return baseline
  const updated = manager.nodeUpdate(ids.get(definition.update.key)!, { properties: { ...definition.update.properties } })
  if (!updated.ok) return updated
  const addition = addNode(definition.addition)
  if (!addition.ok) return addition
  const snapshot = await manager.snapshotCreate('configuration-update', definition.note)
  if (!snapshot.ok) return snapshot
  return ok(manager.getCurrent()!)
}

const creatingStarters = new WeakSet<ProjectManager>()

/** Serializes starter assembly and surfaces a recoverable partial project if storage fails. */
export async function createStarterProject(manager: ProjectManager, request: unknown): Promise<Result<Project>> {
  if (creatingStarters.has(manager)) return err(ErrorCode.VALIDATION_FAILED, 'Wait for the current starter to finish.')
  creatingStarters.add(manager)
  const hadProject = manager.getCurrent() !== null
  try {
    let result: Result<Project>
    try { result = await createStarterProjectUnchecked(manager, request) }
    catch (error) { result = err(ErrorCode.VALIDATION_FAILED, error instanceof Error ? error.message : String(error)) }
    const partial = manager.getCurrent()
    if (!result.ok && !hadProject && partial) {
      return { ok: false, error: { ...result.error, message: `Starter setup was interrupted. Your partial project is available to review: ${result.error.message}`, context: { starterProjectPath: partial.path } } }
    }
    return result
  } finally { creatingStarters.delete(manager) }
}
