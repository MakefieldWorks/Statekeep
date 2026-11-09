// Schema migration pipeline for `.statekeep/history.json`.
// Mirrors the document migrate pattern in src/shared/migration.ts.
//
// History tracking shipped at version 1. Future versions plug in here:
// register a migrator under its target version, bump CURRENT_VERSION, done.

import type { SnapshotTimelineEvent, RecoveryPoint } from './types'

const CURRENT_VERSION = 2

export interface SnapshotHistoryState {
  version: number
  currentBaseSnapshotId: string | null
  pendingRevertEventId: string | null
  snapshots: Record<string, {
    id: string
    basedOnSnapshotId: string | null
    createdAfterRevertEventId: string | null
    note: string | null
  }>
  events: SnapshotTimelineEvent[]
  recoveryPoints: RecoveryPoint[]
}

export function emptySnapshotHistory(): SnapshotHistoryState {
  return {
    version: CURRENT_VERSION,
    currentBaseSnapshotId: null,
    pendingRevertEventId: null,
    snapshots: {},
    events: [],
    recoveryPoints: [],
  }
}

// Key = target version. migrations[2] would migrate v1 → v2.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const migrations: Record<number, (data: any) => any> = {
  // v2 supports explicitly reconciled recovery files without invented lineage.
  2: data => ({ ...data, version: 2 }),
}

export class SnapshotHistoryVersionError extends Error {
  constructor(public readonly fromVersion: number, public readonly toVersion: number) {
    super(
      `Cannot migrate snapshot history from version ${fromVersion} to ${toVersion}: no migrator registered`
    )
    this.name = 'SnapshotHistoryVersionError'
  }
}

// Git tags cannot reconstruct descriptions, recovery points, or revert lineage.
// Reject unreadable metadata instead of silently replacing it with empty state.
export function migrateSnapshotHistory(raw: unknown): SnapshotHistoryState {
  if (!isRecord(raw)) throw new Error('History metadata must be an object')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any = { ...raw }
  const version = typeof data.version === 'number' ? data.version : 1
  if (data.version !== undefined && (!Number.isInteger(data.version) || data.version < 1)) {
    throw new Error('Invalid history metadata version')
  }
  data.version = version

  if (version > CURRENT_VERSION) {
    throw new SnapshotHistoryVersionError(version, CURRENT_VERSION)
  }

  while (data.version < CURRENT_VERSION) {
    const migrator = migrations[data.version + 1]
    if (!migrator) throw new SnapshotHistoryVersionError(data.version, CURRENT_VERSION)
    data = migrator(data)
  }

  validateHistory(data)
  return {
    version: CURRENT_VERSION,
    currentBaseSnapshotId: data.currentBaseSnapshotId ?? null,
    pendingRevertEventId: data.pendingRevertEventId ?? null,
    snapshots: data.snapshots ?? {},
    events: Array.isArray(data.events) ? data.events : [],
    recoveryPoints: Array.isArray(data.recoveryPoints) ? data.recoveryPoints : [],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function optionalText(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string'
}

function validateHistory(data: Record<string, unknown>): void {
  if (!isRecord(data.snapshots) || !Array.isArray(data.events) || !Array.isArray(data.recoveryPoints) ||
      !optionalText(data.currentBaseSnapshotId) || !optionalText(data.pendingRevertEventId)) {
    throw new Error('Invalid history metadata structure')
  }
  for (const [id, meta] of Object.entries(data.snapshots)) {
    if (!isRecord(meta) || meta.id !== id || !optionalText(meta.note) ||
        !optionalText(meta.basedOnSnapshotId) || !optionalText(meta.createdAfterRevertEventId)) {
      throw new Error('Invalid snapshot metadata entry')
    }
  }
  const eventIds = new Set<string>()
  for (const event of data.events) {
    if (!isRecord(event) || typeof event.id !== 'string' || !event.id || eventIds.has(event.id) ||
        typeof event.createdAt !== 'string' || !Number.isFinite(Date.parse(event.createdAt)) ||
        !optionalText(event.note) || !optionalText(event.safetyRecoveryPointId) ||
        !(event.type === 'snapshot' && typeof event.snapshotId === 'string' && event.snapshotId ||
          event.type === 'revert' && typeof event.targetSnapshotId === 'string' && event.targetSnapshotId ||
          event.type === 'recover' && typeof event.recoveryPointId === 'string' && event.recoveryPointId)) {
      throw new Error('Invalid history timeline event')
    }
    eventIds.add(event.id)
  }
  const recoveryIds = new Set<string>()
  for (const point of data.recoveryPoints) {
    if (!isRecord(point) || typeof point.id !== 'string' || !point.id || recoveryIds.has(point.id) ||
        typeof point.createdAt !== 'string' || !Number.isFinite(Date.parse(point.createdAt)) ||
        (point.reason !== 'pre-revert' && point.reason !== 'reconciled') || typeof point.payloadPath !== 'string' ||
        !/^\.statekeep[/\\]recovery[/\\][^/\\]+\.json$/.test(point.payloadPath) || point.payloadPath.includes('..')) {
      throw new Error('Invalid recovery point metadata')
    }
    recoveryIds.add(point.id)
  }
}

export function getCurrentSnapshotHistoryVersion(): number {
  return CURRENT_VERSION
}
