import { statSync } from 'fs'
import { dirname, extname } from 'path'
import { err, ok, ErrorCode } from '../shared/errors'
import type { Result } from '../shared/types'
import { findProjectDocument, PROJECT_DOCUMENT_EXTENSION } from './project-document-file'

/**
 * Resolves a path the user asked to open (a project folder or its
 * Statekeep.statekeep document) to the project folder.
 */
export function resolveProjectOpenTarget(targetPath: string): Result<string> {
  try {
    const stat = statSync(targetPath)

    if (stat.isDirectory()) {
      return validateProjectDirectory(targetPath)
    }

    if (!stat.isFile()) {
      return err(ErrorCode.PROJECT_NOT_FOUND, `Cannot open ${targetPath}: not a project file or folder`)
    }

    if (extname(targetPath) === PROJECT_DOCUMENT_EXTENSION) {
      // Documents live in their project folder under one fixed name.
      if (findProjectDocument(dirname(targetPath)) === targetPath) {
        return validateProjectDirectory(dirname(targetPath))
      }
      return err(ErrorCode.PROJECT_NOT_FOUND, `Cannot open ${targetPath}: it is not the project document in its folder`)
    }

    return err(
      ErrorCode.PROJECT_NOT_FOUND,
      `Cannot open ${targetPath}: expected a Statekeep project folder or .statekeep file`
    )
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return err(ErrorCode.PROJECT_NOT_FOUND, `Cannot open ${targetPath}: ${msg}`)
  }
}

function validateProjectDirectory(projectPath: string): Result<string> {
  if (!findProjectDocument(projectPath)) {
    return err(ErrorCode.PROJECT_NOT_FOUND, `Cannot open ${projectPath}: no Statekeep project document was found`)
  }
  return ok(projectPath)
}
