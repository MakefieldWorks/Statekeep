import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { err, ErrorCode, ok } from '../shared/errors'
import type { NodeTemplate, Project, Result } from '../shared/types'
import { ProjectManager } from './project-manager'
import { findProjectDocument } from './project-document-file'

export const EXAMPLE_PROJECT_NAME = 'Statekeep Sample Lab'

const locationTemplate: NodeTemplate = {
  label: 'Location',
  fields: {
    purpose: { type: 'string' },
    status: { type: 'enum', options: ['active', 'maintenance'] },
  },
}

const deviceTemplate: NodeTemplate = {
  label: 'Device',
  fields: {
    serial: { type: 'string' },
    firmware: { type: 'version' },
    status: { type: 'enum', options: ['active', 'maintenance'] },
  },
}

function createExampleNode(
  projectManager: ProjectManager,
  parentId: string,
  name: string,
  templateId: string,
  properties: Record<string, string>,
): Result<string> {
  const previousNodeIds = new Set(projectManager.getCurrent()?.nodes.map((node) => node.id))
  const created = projectManager.nodeCreate(parentId, name, templateId)
  if (!created.ok) return created

  const createdNode = created.data.nodes.find((node) => !previousNodeIds.has(node.id))
  if (!createdNode) {
    return err(ErrorCode.INVALID_HIERARCHY, `The sample ${name} node could not be created`)
  }

  const updated = projectManager.nodeUpdate(createdNode.id, { properties })
  if (!updated.ok) return updated

  return ok(createdNode.id)
}

async function createExampleSnapshot(
  projectManager: ProjectManager,
  name: string,
  description: string,
): Promise<Result<void>> {
  const created = await projectManager.snapshotCreate(name, description)
  return created.ok ? ok(undefined) : created
}

/**
 * Creates a compact, user-owned project that demonstrates templates, snapshots,
 * and a meaningful comparison. Reopening it never overwrites the user's copy.
 */
export async function openExampleProject(
  projectManager: ProjectManager,
  examplesDirectory: string,
): Promise<Result<Project>> {
  const projectPath = join(examplesDirectory, EXAMPLE_PROJECT_NAME)

  if (findProjectDocument(projectPath)) {
    return projectManager.openProject(projectPath)
  }
  if (existsSync(projectPath)) {
    return err(
      ErrorCode.PROJECT_EXISTS,
      `Cannot create the sample project because "${projectPath}" already exists and is not a Statekeep project. Rename or remove that folder, then try again.`,
    )
  }

  mkdirSync(examplesDirectory, { recursive: true })
  const created = await projectManager.createProject(EXAMPLE_PROJECT_NAME, examplesDirectory)
  if (!created.ok) return created

  const rootId = created.data.nodes[0]?.id
  if (!rootId) return err(ErrorCode.INVALID_HIERARCHY, 'The sample project root could not be created')

  const locationTemplateResult = projectManager.templateCreate('location', locationTemplate)
  if (!locationTemplateResult.ok) return locationTemplateResult
  const deviceTemplateResult = projectManager.templateCreate('device', deviceTemplate)
  if (!deviceTemplateResult.ok) return deviceTemplateResult

  const room = createExampleNode(projectManager, rootId, 'Systems Room', 'location', {
    purpose: 'Integration testing', status: 'active',
  })
  if (!room.ok) return room

  const rack = createExampleNode(projectManager, room.data, 'Rack A', 'location', {
    purpose: 'Navigation systems', status: 'active',
  })
  if (!rack.ok) return rack

  const controller = createExampleNode(projectManager, rack.data, 'Navigation Controller', 'device', {
    serial: 'NAV-042', firmware: '1.3.0', status: 'active',
  })
  if (!controller.ok) return controller

  const powerSupply = createExampleNode(projectManager, rack.data, 'Power Supply', 'device', {
    serial: 'PS-017', firmware: '2.1.0', status: 'active',
  })
  if (!powerSupply.ok) return powerSupply

  const baseline = await createExampleSnapshot(
    projectManager,
    'baseline-lab',
    'Known-good navigation lab configuration before the firmware update.',
  )
  if (!baseline.ok) return baseline

  const upgradedController = projectManager.nodeUpdate(controller.data, {
    properties: { serial: 'NAV-042', firmware: '1.4.0', status: 'maintenance' },
  })
  if (!upgradedController.ok) return upgradedController

  const telemetry = createExampleNode(projectManager, rack.data, 'Telemetry Gateway', 'device', {
    serial: 'TEL-008', firmware: '3.0.0', status: 'active',
  })
  if (!telemetry.ok) return telemetry

  const update = await createExampleSnapshot(
    projectManager,
    'firmware-update',
    'Navigation controller firmware 1.4.0 under maintenance; telemetry gateway added for validation.',
  )
  if (!update.ok) return update

  const project = projectManager.getCurrent()
  return project ? ok(project) : err(ErrorCode.PROJECT_NOT_FOUND, 'The sample project could not be opened')
}
