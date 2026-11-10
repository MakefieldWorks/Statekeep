// electron-builder 25 has no electronFuses configuration. Flip them in afterPack,
// before either our ad-hoc hook or electron-builder's Developer ID/Windows signer.
const { join } = require('path')
const { existsSync } = require('fs')
const { default: adhocSignMac } = require('./adhoc-sign-mac.cjs')

function packagedExecutable(context) {
  const name = context.packager.appInfo.productFilename
  if (context.electronPlatformName === 'darwin') return join(context.appOutDir, `${name}.app`)
  if (context.electronPlatformName === 'win32') return join(context.appOutDir, `${name}.exe`)
  return join(context.appOutDir, context.packager.executableName)
}

async function requiredFuses(platform) {
  const { FuseVersion, FuseV1Options: F } = await import('@electron/fuses')
  return {
    version: FuseVersion.V1,
    [F.RunAsNode]: false,
    [F.EnableNodeOptionsEnvironmentVariable]: false,
    [F.EnableNodeCliInspectArguments]: false,
    // Electron does not implement embedded ASAR validation on Linux.
    [F.EnableEmbeddedAsarIntegrityValidation]: platform !== 'linux',
    [F.OnlyLoadAppFromAsar]: true,
  }
}

async function verifyFuses(executable, platform) {
  const { getCurrentFuseWire, FuseState } = await import('@electron/fuses')
  const actual = await getCurrentFuseWire(executable)
  const expected = await requiredFuses(platform)
  for (const [key, enabled] of Object.entries(expected)) {
    if (key === 'version') continue
    if (actual[key] !== (enabled ? FuseState.ENABLE : FuseState.DISABLE)) {
      throw new Error(`Packaged Electron fuse ${key} is not ${enabled ? 'enabled' : 'disabled'}`)
    }
  }
}

exports.default = async function hardenElectron(context) {
  const { flipFuses } = await import('@electron/fuses')
  const executable = packagedExecutable(context)
  const resources = context.electronPlatformName === 'darwin'
    ? join(executable, 'Contents', 'Resources') : join(context.appOutDir, 'resources')
  if (!existsSync(join(resources, 'app.asar'))) throw new Error('Security hardening requires app.asar')
  await flipFuses(executable, {
    ...await requiredFuses(context.electronPlatformName),
    resetAdHocDarwinSignature: context.electronPlatformName === 'darwin',
  })
  await verifyFuses(executable, context.electronPlatformName)
  await adhocSignMac(context)
}
exports.verifyFuses = verifyFuses
exports.requiredFuses = requiredFuses
