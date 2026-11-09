import { extname, resolve } from 'path'

export interface LaunchArgumentEnvironment {
  defaultApp: boolean
  appPath: string
}

/**
 * Returns only file/folder arguments intentionally supplied to open in
 * Statekeep. Electron's default-app form is `electron <app-path> ...`, so the
 * app path itself must never be interpreted as a project target.
 */
export function collectProjectOpenTargets(
  argv: string[],
  environment: LaunchArgumentEnvironment,
): string[] {
  const firstTargetIndex = environment.defaultApp ? 2 : 1
  return argv.slice(firstTargetIndex).filter((arg, index) => {
    if (!arg || arg.startsWith('-')) return false
    // Only the first candidate can be Electron's unpackaged entrypoint. Later
    // arguments are intentional open targets, even if they happen to end in .js.
    return index !== 0 || !isRuntimeEntrypointArg(arg, environment.appPath)
  })
}

function isRuntimeEntrypointArg(arg: string, appPath: string): boolean {
  const extension = extname(arg)
  if (extension !== '.js' && extension !== '.mjs' && extension !== '.cjs') return false
  return resolve(arg).startsWith(resolve(appPath))
}

/**
 * True when an OS open request names the unpackaged app folder itself. On
 * macOS, `electron .` (how `bun run dev` launches) can also deliver that `.`
 * argument as an `open-file` event, which is not a request to open a project.
 */
export function isDefaultAppPathTarget(target: string, environment: LaunchArgumentEnvironment): boolean {
  return environment.defaultApp && resolve(target) === resolve(environment.appPath)
}
