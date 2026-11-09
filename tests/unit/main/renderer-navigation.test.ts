import { describe, expect, it } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { isTrustedRendererNavigationUrl } from '../../../src/main/renderer-navigation'

const rendererDirectory = join(tmpdir(), 'Statekeep.app', 'Contents', 'Resources', 'app.asar', 'out', 'renderer')

describe('isTrustedRendererNavigationUrl', () => {
  it('allows packaged renderer resources but rejects other local files', () => {
    expect(isTrustedRendererNavigationUrl(
      pathToFileURL(join(rendererDirectory, 'index.html')).href,
      { rendererDirectory },
    )).toBe(true)
    expect(isTrustedRendererNavigationUrl(pathToFileURL(join(tmpdir(), 'untrusted.html')).href, { rendererDirectory })).toBe(false)
  })

  it('allows only the configured development-server origin', () => {
    const environment = { rendererDirectory, devServerUrl: 'http://localhost:5173' }
    expect(isTrustedRendererNavigationUrl('http://localhost:5173/?settings=1', environment)).toBe(true)
    expect(isTrustedRendererNavigationUrl('http://localhost:4173', environment)).toBe(false)
  })
})
