import { existsSync } from 'fs'
import { join } from 'path'

/**
 * The user-facing Statekeep project document. Its JSON encoding stays readable,
 * while the dedicated extension ensures desktop file associations are unambiguous.
 */
export const PROJECT_DOCUMENT_FILE = 'Statekeep.statekeep'
export const PROJECT_DOCUMENT_EXTENSION = '.statekeep'

/**
 * Returns the project document's path for a project folder, or null when the
 * folder holds no Statekeep project. A malformed document still counts:
 * opening it should surface a validation error, not look like a missing project.
 */
export function findProjectDocument(projectPath: string): string | null {
  const documentPath = join(projectPath, PROJECT_DOCUMENT_FILE)
  return existsSync(documentPath) ? documentPath : null
}
