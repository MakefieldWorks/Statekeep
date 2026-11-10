import { open } from 'fs/promises'
import { join } from 'path'

const LOG_FILES = ['app.log', 'project.log', 'git.log'] as const
export const MAX_LOG_BYTES = 128 * 1024

/** Context fields may contain project content, paths, commands, or credentials.
 * Export only the structural log envelope, never arbitrary context or raw lines.
 */
export function sanitizeLogTail(text: string): string {
  return text.split('\n').flatMap(line => {
    try {
      const entry: unknown = JSON.parse(line)
      if (!entry || typeof entry !== 'object') return []
      const value = entry as Record<string, unknown>
      if (!['error', 'warn', 'info', 'debug'].includes(String(value.level))) return []
      if (typeof value.ts !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value.ts)) return []
      if (typeof value.ns !== 'string' || !/^[a-z-]{1,40}$/.test(value.ns)) return []
      // App log messages are fixed event labels. Reject strings that could be
      // interpolated content; detailed error/context fields stay local.
      if (typeof value.msg !== 'string' || !/^[a-zA-Z0-9 :;.,()—_-]{1,180}$/.test(value.msg)) return []
      return [JSON.stringify({ ts: value.ts, level: value.level, ns: value.ns, msg: value.msg })]
    } catch { return [] }
  }).join('\n')
}

async function readRecentLog(logsPath: string, name: string): Promise<string> {
  let file
  try {
    file = await open(join(logsPath, name), 'r')
    const stat = await file.stat()
    if (!stat.isFile()) return '(unavailable)'
    const start = Math.max(0, stat.size - MAX_LOG_BYTES)
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_LOG_BYTES))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
    const content = buffer.subarray(0, bytesRead).toString('utf8')
    // The first line may start in the middle of an entry.
    return sanitizeLogTail(start ? content.slice(content.indexOf('\n') + 1) : content) || '(no exportable entries)'
  } catch { return '(unavailable)' }
  finally { await file?.close() }
}

export async function buildDiagnosticsBundle(diagnostics: string, logsPath: string): Promise<string> {
  const logs: Record<string, string> = {}
  for (const name of LOG_FILES) logs[name] = await readRecentLog(logsPath, name)
  return JSON.stringify({
    format: 1,
    createdAt: new Date().toISOString(),
    privacy: 'Local-only export. Project files, paths, raw log lines, and log context fields are omitted. Review before sharing.',
    diagnostics,
    logs,
  }, null, 2) + '\n'
}
