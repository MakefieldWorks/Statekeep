import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildDiagnosticsBundle, MAX_LOG_BYTES, sanitizeLogTail } from '../../../src/main/diagnostics-export'

const directories: string[] = []
const entry = { ts: '2026-11-10T12:00:00.000Z', level: 'error', ns: 'project', msg: 'project save failed' }
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('diagnostics export', () => {
  it('omits arbitrary log context, raw lines, and path-bearing messages', () => {
    const sanitized = sanitizeLogTail([
      JSON.stringify({ ...entry, path: '/Users/alice/private', token: 'secret-token', properties: { email: 'alice@example.com' }, error: 'password' }),
      'raw sensitive output',
      JSON.stringify({ ...entry, msg: 'failed /Users/alice/private' }),
      JSON.stringify({ ...entry, msg: 'contact alice@example.com' }),
    ].join('\n'))
    expect(JSON.parse(sanitized)).toEqual(entry)
    expect(sanitized).not.toMatch(/alice|secret|password|properties/)
  })

  it('exports bounded recent logs and handles missing logs without leaking errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'statekeep-diagnostics-')); directories.push(dir)
    const recent = JSON.stringify(entry)
    writeFileSync(join(dir, 'app.log'), 'old secret content\n' + 'x'.repeat(MAX_LOG_BYTES) + '\n' + recent + '\n')
    const bundle = JSON.parse(await buildDiagnosticsBundle('safe diagnostics', dir))
    expect(bundle.format).toBe(1)
    expect(bundle.diagnostics).toBe('safe diagnostics')
    expect(JSON.parse(bundle.logs['app.log'])).toEqual(entry)
    expect(bundle.logs['git.log']).toBe('(unavailable)')
    expect(JSON.stringify(bundle)).not.toContain(dir)
    expect(JSON.stringify(bundle)).not.toContain('old secret')
  })
})
