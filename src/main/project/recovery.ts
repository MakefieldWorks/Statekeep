// Read-only review of recovery material: unlisted files in
// .statekeep/recovery that could be registered as recovery points, and the
// automatic history backup. Both return a token over everything they read so
// a later write can refuse when anything changed since the user reviewed it.

import { existsSync, lstatSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { v7 as uuidv7 } from 'uuid'
import type { Project, RecoveryFilePreview, Result, SnapshotTimelineEvent } from '../../shared/types'
import type { SnapshotHistoryState } from '../../shared/snapshot-history-migration'
import { HistoryBackupStore, type HistoryBackupCandidate } from '../history-backup'
import type { GitService } from '../git-service'
import { MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB } from './document'
import { snapshotHistoryPath } from './history-metadata'

export class HistoryBackupProjectChangedError extends Error {}

export type ValidatedHistoryBackup = HistoryBackupCandidate & { missingSnapshots: string[]; unlistedRecoveryFiles: string[] }

// `readHistory` is called after the directory-link checks so a linked
// metadata directory is reported before any metadata read error.
export function scanRecoveryFiles(
  project: Project,
  readHistory: () => SnapshotHistoryState,
  parse: (raw: string) => Result<Project>,
): RecoveryFilePreview {
  const directory = join(project.path!, '.statekeep', 'recovery')
  const metadataDirectory = join(project.path!, '.statekeep')
  if (existsSync(metadataDirectory) && lstatSync(metadataDirectory).isSymbolicLink()) {
    throw new Error('The metadata directory must not be a link.')
  }
  if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) {
    throw new Error('The recovery directory must be a local directory, not a link.')
  }
  const history = readHistory()
  const hash = createHash('sha256').update(project.id).update(project.path!)
  // Include the exact primary bytes so even a semantically equivalent edit
  // invalidates the preview. Missing legacy metadata has a distinct token.
  const metadataPath = snapshotHistoryPath(project.path!)
  hash.update(existsSync(metadataPath) ? readFileSync(metadataPath) : 'missing')
  const files: RecoveryFilePreview['files'] = []
  let uninspectedCount = 0
  let inspectedBytes = 0
  if (!existsSync(directory)) return { token: hash.digest('hex'), files, uninspectedCount }
  const registered = new Set(history.recoveryPoints.map(point => point.payloadPath.split(/[/\\]/).pop()))
  for (const name of readdirSync(directory).sort()) {
    hash.update(JSON.stringify(name))
    if (registered.has(name) || name.startsWith('.')) continue
    if (files.length >= 100) { uninspectedCount++; continue }
    const file = { name, eligible: false, explanation: '' } as RecoveryFilePreview['files'][number]
    files.push(file)
    try {
      const path = join(directory, name)
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Not a regular local file.')
      if (!/^recovery-[a-zA-Z0-9-]+\.document\.json$/.test(name)) throw new Error('Unrecognized recovery filename; left untouched.')
      if (stat.size > MAX_FILE_SIZE_BYTES) throw new Error(`Recovery file exceeds the ${MAX_FILE_SIZE_MB} MB limit.`)
      if (inspectedBytes + stat.size > MAX_FILE_SIZE_BYTES) throw new Error('Not inspected: this review reached its 50 MB total limit. Move other unlisted files to a safe external folder and review again.')
      const bytes = readFileSync(path)
      // The stat precheck is a soft I/O limit: external writers can grow a
      // file during read. Charge actual bytes and refuse to parse overflow.
      inspectedBytes += bytes.length
      if (inspectedBytes > MAX_FILE_SIZE_BYTES) throw new Error('Not inspected: files grew beyond the 50 MB review limit. Review again after file changes finish.')
      hash.update(createHash('sha256').update(bytes).digest())
      const parsed = parse(bytes.toString('utf8'))
      if (!parsed.ok) throw new Error(parsed.error.message)
      if (parsed.data.id !== project.id) throw new Error('This file belongs to another project.')
      const id = name.slice(0, -'.document.json'.length)
      if (history.recoveryPoints.some(point => point.id === id)) throw new Error('Recovery ID is already registered to another file.')
      file.eligible = true
      file.projectName = parsed.data.name
      file.nodeCount = parsed.data.nodes.length
      file.explanation = 'Original save time and operation context are unknown.'
    } catch (error) {
      file.explanation = error instanceof Error ? error.message : String(error)
    }
    hash.update(JSON.stringify(file))
  }
  return { token: hash.digest('hex'), files, uninspectedCount }
}

// Validate the automatic history backup against git and the recovery
// payloads it lists, and reconstruct snapshot events it is missing.
// `isStillCurrent` is checked after the git await: the user may have switched
// projects while it ran.
export async function validateHistoryBackup(
  project: Project | null,
  git: GitService,
  isStillCurrent: () => boolean,
  parse: (raw: string) => Result<Project>,
): Promise<ValidatedHistoryBackup> {
  if (!project?.path) throw new Error('No project is currently open')
  const candidate = new HistoryBackupStore(project.path, project.id).candidate()
  const snapshots = await git.listSnapshots(project.path)
  if (!isStillCurrent()) {
    throw new HistoryBackupProjectChangedError('The project changed while checking the backup. Try reviewing the backup again.')
  }
  const names = new Set(snapshots.map(snapshot => snapshot.id))
  const refs = [
    ...Object.keys(candidate.history.snapshots),
    ...Object.values(candidate.history.snapshots).map(meta => meta.basedOnSnapshotId),
    ...candidate.history.events.flatMap(event => [event.snapshotId, event.targetSnapshotId]),
    candidate.history.currentBaseSnapshotId,
  ].filter((value): value is string => Boolean(value))
  const unavailable = refs.filter(ref => !names.has(ref))
  if (unavailable.length) throw new Error(`Backup snapshots are unavailable: ${[...new Set(unavailable)].join(', ')}`)
  const payloadHashes: string[] = []
  for (const point of candidate.history.recoveryPoints) {
    const path = join(project.path, ...point.payloadPath.split(/[\\/]/))
    const payload = readFileSync(path)
    payloadHashes.push(createHash('sha256').update(payload).digest('hex'))
    const parsed = parse(payload.toString('utf8'))
    if (!parsed.ok || parsed.data.id !== project.id) {
      throw new Error(`Recovery file for ${point.id} is invalid or belongs to another project.`)
    }
  }
  const recorded = new Set(candidate.history.events.filter(event => event.type === 'snapshot').map(event => event.snapshotId))
  const missing = snapshots.filter(snapshot => !recorded.has(snapshot.id))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  // Reconstruct missing snapshot events from Git. Preserve recorded ordering;
  // insert by timestamp, placing second-resolution ties after recorded events.
  // Exact historical order and descriptions cannot be recovered from tags.
  for (const snapshot of missing) {
    const event: SnapshotTimelineEvent = {
      id: uuidv7(), type: 'snapshot', createdAt: snapshot.createdAt,
      snapshotId: snapshot.id, note: candidate.history.snapshots[snapshot.id]?.note ?? null,
    }
    const index = candidate.history.events.findIndex(existing =>
      Math.floor(Date.parse(existing.createdAt) / 1000) > Math.floor(Date.parse(event.createdAt) / 1000))
    if (index < 0) candidate.history.events.push(event)
    else candidate.history.events.splice(index, 0, event)
  }
  let recoveryFiles: string[] = []
  try { recoveryFiles = readdirSync(join(project.path, '.statekeep', 'recovery')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const registered = new Set(candidate.history.recoveryPoints.map(point => point.payloadPath.split(/[\\/]/).pop()))
  const token = createHash('sha256').update(JSON.stringify([
    candidate.sourceToken, snapshots.map(snapshot => [snapshot.id, snapshot.commitHash]).sort(), payloadHashes, recoveryFiles.sort(),
  ])).digest('hex')
  return { ...candidate, token, missingSnapshots: missing.map(snapshot => snapshot.name),
    unlistedRecoveryFiles: recoveryFiles.filter(name => name.endsWith('.document.json') && !registered.has(name)).sort() }
}
