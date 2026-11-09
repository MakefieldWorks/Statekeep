import Database from 'better-sqlite3'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import type { ProjectNode, Project } from '../shared/types'

export const SEARCH_RESULT_LIMIT = 50
export const MAX_SEARCH_RESULT_LIMIT = 200

export function normalizeSearchPage(offset = 0, limit = SEARCH_RESULT_LIMIT): { offset: number; limit: number } {
  return {
    offset: Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0,
    limit: Number.isFinite(limit)
      ? Math.max(1, Math.min(MAX_SEARCH_RESULT_LIMIT, Math.floor(limit)))
      : SEARCH_RESULT_LIMIT,
  }
}

interface SearchRow {
  nodeId: string
  nodeName: string
  propertiesText: string
  rank: number
}

interface SearchCountRow {
  total: number
}

export interface SearchIndexHit {
  nodeId: string
  nodeName: string
  matchField: 'name' | 'property'
  snippet: string
}

export interface SearchIndexPage {
  hits: SearchIndexHit[]
  total: number
  offset: number
  hasMore: boolean
}

export class SearchIndexService {
  private db: Database.Database | null = null
  private dbPath: string | null = null
  private projectPath: string | null = null
  private indexedNodeIds = new Set<string>()

  rebuild(project: Project): void {
    if (!project.path) {
      throw new Error('Project has no path — cannot rebuild search index')
    }

    this.withFreshDatabase(project.path, (db) => {
      const clear = db.prepare('DELETE FROM node_search')
      const insert = db.prepare<[string, string, string]>(
        'INSERT INTO node_search (node_id, node_name, properties_text) VALUES (?, ?, ?)'
      )

      const rebuildAll = db.transaction((nodes: ProjectNode[]) => {
        clear.run()
        for (const node of nodes) {
          insert.run(node.id, node.name, serializeProperties(node))
        }
      })

      rebuildAll(project.nodes)
    })
    this.indexedNodeIds = new Set(project.nodes.map(node => node.id))
  }

  close(): void {
    if (this.db?.open) {
      this.db.close()
    }
    this.db = null
    this.dbPath = null
    this.projectPath = null
    this.indexedNodeIds.clear()
  }

  upsertNode(projectPath: string, node: ProjectNode): void {
    const db = this.requireDatabase(projectPath)
    const upsert = db.transaction((searchNode: ProjectNode) => {
      db.prepare<[string]>('DELETE FROM node_search WHERE node_id = ?').run(searchNode.id)
      db.prepare<[string, string, string]>(
        'INSERT INTO node_search (node_id, node_name, properties_text) VALUES (?, ?, ?)'
      ).run(searchNode.id, searchNode.name, serializeProperties(searchNode))
    })

    upsert(node)
    this.indexedNodeIds.add(node.id)
  }

  deleteNodes(projectPath: string, nodeIds: string[]): void {
    if (nodeIds.length === 0) return

    const db = this.requireDatabase(projectPath)
    const remove = db.prepare<[string]>('DELETE FROM node_search WHERE node_id = ?')
    const deleteAll = db.transaction((ids: string[]) => {
      for (const nodeId of ids) {
        remove.run(nodeId)
      }
    })

    deleteAll(nodeIds)
    for (const nodeId of nodeIds) this.indexedNodeIds.delete(nodeId)
  }

  hasExactNodeSet(projectPath: string, nodeIds: Iterable<string>): boolean {
    this.requireDatabase(projectPath)
    const expected = new Set(nodeIds)
    if (expected.size !== this.indexedNodeIds.size) return false
    for (const nodeId of expected) {
      if (!this.indexedNodeIds.has(nodeId)) return false
    }
    return true
  }

  query(projectPath: string, query: string, limit = SEARCH_RESULT_LIMIT): SearchIndexHit[] {
    return this.queryPage(projectPath, query, 0, limit).hits
  }

  queryPage(
    projectPath: string,
    query: string,
    offset = 0,
    limit = SEARCH_RESULT_LIMIT,
    scopeNodeIds?: Iterable<string>,
  ): SearchIndexPage {
    const db = this.requireDatabase(projectPath)
    const trimmed = query.trim()
    const { offset: safeOffset, limit: safeLimit } = normalizeSearchPage(offset, limit)
    if (!trimmed) return { hits: [], total: 0, offset: safeOffset, hasMore: false }
    const scopeIds = scopeNodeIds ? [...new Set(scopeNodeIds)] : null
    if (scopeIds?.length === 0) return { hits: [], total: 0, offset: safeOffset, hasMore: false }
    if (scopeIds) this.replaceSearchScope(db, scopeIds)

    try {
      return this.queryPreparedPage(db, trimmed, safeOffset, safeLimit, scopeIds !== null)
    } finally {
      if (scopeIds) this.clearSearchScope(db)
    }
  }

  queryAll(
    projectPath: string,
    query: string,
    scopeNodeIds?: Iterable<string>,
  ): SearchIndexHit[] {
    const db = this.requireDatabase(projectPath)
    const trimmed = query.trim()
    if (!trimmed) return []
    const scopeIds = scopeNodeIds ? [...new Set(scopeNodeIds)] : null
    if (scopeIds?.length === 0) return []
    if (scopeIds) this.replaceSearchScope(db, scopeIds)
    try {
      return this.queryPreparedPage(
        db,
        trimmed,
        0,
        -1,
        scopeIds !== null,
      ).hits
    } finally {
      if (scopeIds) this.clearSearchScope(db)
    }
  }

  private queryPreparedPage(
    db: Database.Database,
    trimmed: string,
    safeOffset: number,
    safeLimit: number,
    scoped: boolean,
  ): SearchIndexPage {
    const queryTokens = tokenize(trimmed)
    const ftsQuery = buildFtsQuery(queryTokens)
    const pattern = `%${escapeLike(trimmed.toLowerCase())}%`
    const scopeJoin = scoped ? 'INNER JOIN search_scope ON search_scope.node_id = node_search.node_id' : ''
    const matchCte = ftsQuery ? `
      WITH ranked AS (
        SELECT
          node_search.node_id AS nodeId,
          node_search.node_name AS nodeName,
          node_search.properties_text AS propertiesText,
          bm25(node_search) AS rank
        FROM node_search
        ${scopeJoin}
        WHERE node_search MATCH ?
      ),
      fallback AS (
        SELECT
          node_search.node_id AS nodeId,
          node_search.node_name AS nodeName,
          node_search.properties_text AS propertiesText,
          1000.0 AS rank
        FROM node_search
        ${scopeJoin}
        WHERE (
          lower(node_search.node_name) LIKE ? ESCAPE '\\'
          OR lower(node_search.properties_text) LIKE ? ESCAPE '\\'
        )
        AND node_search.node_id NOT IN (SELECT nodeId FROM ranked)
      ),
      combined AS (
        SELECT * FROM ranked
        UNION ALL
        SELECT * FROM fallback
      )
    ` : `
      WITH combined AS (
        SELECT
          node_search.node_id AS nodeId,
          node_search.node_name AS nodeName,
          node_search.properties_text AS propertiesText,
          1000.0 AS rank
        FROM node_search
        ${scopeJoin}
        WHERE (
          lower(node_search.node_name) LIKE ? ESCAPE '\\'
          OR lower(node_search.properties_text) LIKE ? ESCAPE '\\'
        )
      )
    `
    const matchParams = ftsQuery ? [ftsQuery, pattern, pattern] : [pattern, pattern]
    const countRow = db.prepare(`${matchCte} SELECT COUNT(*) AS total FROM combined`)
      .get(...matchParams) as SearchCountRow
    const total = countRow.total
    const pageRows = db.prepare(`
      ${matchCte}
      SELECT nodeId, nodeName, propertiesText, rank
      FROM combined
      ORDER BY rank, nodeName COLLATE NOCASE, nodeId
      LIMIT ? OFFSET ?
    `).all(...matchParams, safeLimit, safeOffset) as SearchRow[]
    const pageHits = pageRows.map((row) => {
      const matchField = detectMatchField(row.nodeName, row.propertiesText, trimmed, queryTokens)
      return {
        nodeId: row.nodeId,
        nodeName: row.nodeName,
        matchField,
        snippet: matchField === 'name'
          ? row.nodeName
          : extractSnippet(row.propertiesText, trimmed),
      }
    })

    return {
      hits: pageHits,
      total,
      offset: safeOffset,
      hasMore: safeOffset + pageHits.length < total,
    }
  }

  private replaceSearchScope(db: Database.Database, nodeIds: string[]): void {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS search_scope (node_id TEXT PRIMARY KEY)')
    const replace = db.transaction((ids: string[]) => {
      db.prepare('DELETE FROM search_scope').run()
      const batchSize = 500
      for (let start = 0; start < ids.length; start += batchSize) {
        const batch = ids.slice(start, start + batchSize)
        const values = batch.map(() => '(?)').join(', ')
        db.prepare(`INSERT INTO search_scope (node_id) VALUES ${values}`).run(...batch)
      }
    })
    replace(nodeIds)
  }

  private clearSearchScope(db: Database.Database): void {
    db.prepare('DELETE FROM search_scope').run()
  }

  private withFreshDatabase(projectPath: string, seed: (db: Database.Database) => void): void {
    const { db, dbPath } = this.openDatabase(projectPath)

    try {
      seed(db)
    } catch (error) {
      if (db.open) {
        db.close()
      }
      rmSync(dbPath, { force: true })
      throw error
    }

    this.close()
    this.db = db
    this.dbPath = dbPath
    this.projectPath = projectPath
  }

  private requireDatabase(projectPath: string): Database.Database {
    if (!this.db || !this.projectPath || this.projectPath !== projectPath) {
      throw new Error('Search index is not open for the current project')
    }

    return this.db
  }

  private openDatabase(projectPath: string): { db: Database.Database; dbPath: string } {
    const dbPath = join(projectPath, '.statekeep', 'index', 'search.db')
    mkdirSync(join(projectPath, '.statekeep', 'index'), { recursive: true })

    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS node_search USING fts5(
        node_id UNINDEXED,
        node_name,
        properties_text,
        tokenize = 'unicode61'
      );
    `)

    return { db, dbPath }
  }
}

function serializeProperties(node: ProjectNode): string {
  return Object.entries(node.properties)
    .map(([key, value]) => `${key}: ${value === null ? 'null' : String(value)}`)
    .join('\n')
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

function buildFtsQuery(tokens: string[]): string | null {
  if (tokens.length === 0) return null
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(' AND ')
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

function detectMatchField(
  nodeName: string,
  propertiesText: string,
  query: string,
  tokens: string[]
): 'name' | 'property' {
  const normalizedQuery = query.toLowerCase()
  const lowerName = nodeName.toLowerCase()
  const lowerProperties = propertiesText.toLowerCase()

  if (lowerName.includes(normalizedQuery)) return 'name'
  if (lowerProperties.includes(normalizedQuery)) return 'property'
  if (matchesTokenPrefixes(lowerName, tokens)) return 'name'
  return 'property'
}

function matchesTokenPrefixes(text: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false
  const textTokens = tokenize(text)
  return tokens.every((token) => textTokens.some((textToken) => textToken.startsWith(token)))
}

function extractSnippet(propertiesText: string, query: string): string {
  if (!propertiesText) return ''

  const normalizedText = propertiesText.toLowerCase()
  const normalizedQuery = query.toLowerCase()
  const matchIndex = normalizedText.indexOf(normalizedQuery)

  if (matchIndex === -1) {
    return propertiesText.split('\n')[0]?.slice(0, 80) ?? ''
  }

  const start = Math.max(0, matchIndex - 20)
  const end = Math.min(propertiesText.length, matchIndex + query.length + 40)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < propertiesText.length ? '…' : ''
  return `${prefix}${propertiesText.slice(start, end)}${suffix}`.trim()
}
