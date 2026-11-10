// The Windows installer's license page wraps text itself, so the beforePack hook
// (scripts/installer-license.cjs) joins each LICENSE paragraph onto one line.
import { createRequire } from 'module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, it, expect } from 'vitest'

const require = createRequire(import.meta.url)
const { unwrapParagraphs } = require('../../scripts/installer-license.cjs') as {
  unwrapParagraphs: (text: string) => string
}
const writeInstallerLicense = require('../../scripts/installer-license.cjs').default as (context: {
  electronPlatformName: string; packager: { info: { projectDir: string } }
}) => Promise<void>

describe('unwrapParagraphs', () => {
  it('joins wrapped lines and keeps blank lines between paragraphs', () => {
    expect(unwrapParagraphs('Title\n\nOne two\nthree four\n  five\n\nLast\n')).toBe(
      'Title\r\n\r\nOne two three four five\r\n\r\nLast\r\n',
    )
  })

  it('accepts CRLF input', () => {
    expect(unwrapParagraphs('a\r\nb\r\n\r\nc\r\n')).toBe('a b\r\n\r\nc\r\n')
  })

  it('keeps every word of the repository LICENSE', () => {
    const license = readFileSync('LICENSE', 'utf8')
    const unwrapped = unwrapParagraphs(license)
    expect(unwrapped.split(/\s+/).filter(Boolean)).toEqual(license.split(/\s+/).filter(Boolean))
    expect(unwrapped.split('\r\n\r\n')).toHaveLength(license.trim().split(/\n\s*\n/).length)
  })

  it('writes the Windows license without changing the repository source or running for other platforms', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'statekeep-license-'))
    try {
      const license = 'MIT License\n\nPermission is\nhereby granted.\n'
      writeFileSync(join(directory, 'LICENSE'), license)
      const context = { electronPlatformName: 'darwin', packager: { info: { projectDir: directory } } }
      await writeInstallerLicense(context)
      expect(existsSync(join(directory, 'dist'))).toBe(false)
      await writeInstallerLicense({ ...context, electronPlatformName: 'win32' })
      expect(readFileSync(join(directory, 'dist/installer-license.txt'), 'utf8')).toBe('MIT License\r\n\r\nPermission is hereby granted.\r\n')
      expect(readFileSync(join(directory, 'LICENSE'), 'utf8')).toBe(license)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
