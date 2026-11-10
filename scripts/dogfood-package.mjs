import { cpSync, mkdtempSync, rmSync } from 'fs'
import { basename, dirname, join, relative } from 'path'
import { tmpdir } from 'os'
import { flipFuses, FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses'
import { verifyFuses } from './harden-electron.cjs'

/** Playwright requires a main-process inspector. Never enable it on a release
 * artifact: instrument a disposable full package copy and remove it afterwards.
 * ASAR contents and all other release fuse states remain unchanged.
 */
export async function prepareDogfoodPackage(executable, platform = process.platform) {
  await verifyFuses(executable, platform)
  const packageDirectory = platform === 'darwin' ? dirname(dirname(dirname(executable))) : dirname(executable)
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'statekeep-instrumented-dogfood-'))
  const cleanup = () => rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  try {
    const copyDirectory = join(temporaryDirectory, basename(packageDirectory))
    cpSync(packageDirectory, copyDirectory, { recursive: true, verbatimSymlinks: true })
    const testExecutable = join(copyDirectory, relative(packageDirectory, executable))
    const app = platform === 'darwin' ? copyDirectory : testExecutable
    await flipFuses(app, {
      version: FuseVersion.V1,
      [FuseV1Options.EnableNodeCliInspectArguments]: true,
      resetAdHocDarwinSignature: platform === 'darwin',
    })
    if ((await getCurrentFuseWire(app))[FuseV1Options.EnableNodeCliInspectArguments] !== FuseState.ENABLE) {
      throw new Error('Could not enable inspector on disposable dogfood package')
    }
    // Fail if instrumentation ever accidentally changes the source package.
    await verifyFuses(executable, platform)
    return { executable: testExecutable, cleanup }
  } catch (error) { cleanup(); throw error }
}
