import { describe, expect, it } from 'vitest'
import { isE2eBackground } from '../../../src/main/e2e-background'

describe('isE2eBackground', () => {
  it('requires both the test environment and the explicit background flag', () => {
    expect(isE2eBackground({ NODE_ENV: 'test', STATEKEEP_E2E_BACKGROUND: '1' })).toBe(true)
    expect(isE2eBackground({ STATEKEEP_E2E_BACKGROUND: '1' })).toBe(false)
    expect(isE2eBackground({ NODE_ENV: 'production', STATEKEEP_E2E_BACKGROUND: '1' })).toBe(false)
    expect(isE2eBackground({ NODE_ENV: 'test' })).toBe(false)
    expect(isE2eBackground({ NODE_ENV: 'test', STATEKEEP_E2E_BACKGROUND: '0' })).toBe(false)
  })
})
