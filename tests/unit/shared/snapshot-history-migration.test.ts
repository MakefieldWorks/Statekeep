import { describe, expect, it } from 'vitest'
import { emptySnapshotHistory, migrateSnapshotHistory, SnapshotHistoryVersionError } from '../../../src/shared/snapshot-history-migration'

describe('snapshot history validation', () => {
  it('upgrades v1 without changing nested records or inventing recovery context', () => {
    const raw = { ...emptySnapshotHistory(), version: 1,
      recoveryPoints: [{ id: 'old', reason: 'pre-revert', createdAt: '2026-09-10T00:00:00Z', payloadPath: '.statekeep/recovery/old.json' }] }
    const original = structuredClone(raw)
    const migrated = migrateSnapshotHistory(raw)
    expect(migrated.version).toBe(2)
    expect(migrated.recoveryPoints).toEqual(original.recoveryPoints)
    expect(raw).toEqual(original)
  })

  it('accepts current and unversioned legacy metadata without mutating the input', () => {
    const current = emptySnapshotHistory()
    expect(migrateSnapshotHistory(current)).toEqual(current)
    const { version: _version, ...legacy } = current
    expect(migrateSnapshotHistory(Object.freeze(legacy))).toEqual(current)
    expect(legacy).not.toHaveProperty('version')
  })

  it('refuses future versions rather than erasing their provenance', () => {
    expect(() => migrateSnapshotHistory({ ...emptySnapshotHistory(), version: 999 }))
      .toThrow(SnapshotHistoryVersionError)
  })

  it.each(['unknown', ['pre-revert'], null])('rejects invalid recovery reasons: %j', reason => {
    const history = { ...emptySnapshotHistory(), recoveryPoints: [{ id: 'point', reason,
      createdAt: '2026-09-10T00:00:00Z', payloadPath: '.statekeep/recovery/point.json' }] }
    expect(() => migrateSnapshotHistory(history)).toThrow('Invalid recovery point metadata')
  })

  it.each([
    null, [], {}, { ...emptySnapshotHistory(), version: '1' },
    { ...emptySnapshotHistory(), events: {} },
    { ...emptySnapshotHistory(), snapshots: [] },
    { ...emptySnapshotHistory(), recoveryPoints: 'bad' },
    { ...emptySnapshotHistory(), snapshots: { tag: { id: 'other' } } },
    { ...emptySnapshotHistory(), events: [{ id: 'event', type: 'snapshot', createdAt: 'bad', snapshotId: 'tag' }] },
  ])('rejects malformed metadata: %j', value => {
    expect(() => migrateSnapshotHistory(value)).toThrow()
  })

  it.each(['.statekeep/recovery/recovery-1.document.json', '.statekeep\\recovery\\recovery-1.document.json'])('accepts native recovery paths: %s', payloadPath => {
    const history = emptySnapshotHistory()
    history.recoveryPoints.push({ id: 'recovery-1', createdAt: '2026-09-09T00:00:00Z', reason: 'pre-revert', payloadPath })
    expect(migrateSnapshotHistory(history)).toEqual(history)
  })

  it.each(['../outside.json', '.statekeep/recovery/../../outside.json', '/tmp/outside.json'])('rejects recovery paths outside the payload directory: %s', payloadPath => {
    const history = emptySnapshotHistory()
    history.recoveryPoints.push({ id: 'recovery-1', createdAt: '2026-09-09T00:00:00Z', reason: 'pre-revert', payloadPath })
    expect(() => migrateSnapshotHistory(history)).toThrow('Invalid recovery point metadata')
  })
})
