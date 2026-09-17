import { openDB, type DBSchema } from 'idb'
import type { Session } from '../types'
import { historyApi } from './historyApi'

interface LegacyHistoryDB extends DBSchema {
  sessions: { key: string; value: Session & { __postgresMigrated?: boolean } }
}
const revisions = new Map<string, number>()
let operations: Promise<unknown> = Promise.resolve()
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = operations.catch(() => {}).then(operation)
  operations = result
  return result
}

// IndexedDB is read only as a migration source; originals remain available as a backup.
async function migrateLegacy() {
  if (typeof indexedDB === 'undefined') return
  const db = await openDB<LegacyHistoryDB>('rabbit-hole', 1, {
    upgrade(database) {
      database.createObjectStore('sessions', { keyPath: 'id' })
    },
  })
  try {
    let failed = false
    for (const record of await db.getAll('sessions')) {
      const { __postgresMigrated, ...session } = record
      if (__postgresMigrated) continue
      try {
        await historyApi.import(session)
        // Mark only after a committed import or confirmed existing/deleted server ID.
        await db.put('sessions', { ...session, __postgresMigrated: true })
      } catch {
        failed = true
      }
    }
    if (failed) throw Error('legacy_migration_incomplete')
  } finally {
    db.close()
  }
}

export function saveSession(session: Session) {
  const snapshot = structuredClone(session)
  return serialize(async () => {
    const result = await historyApi.save(snapshot.id, { session: snapshot, revision: revisions.get(snapshot.id) ?? 0 })
    revisions.set(snapshot.id, result.revision)
  })
}
export function loadSessions(onMigrationError?: (message: string) => void) {
  return serialize(async () => {
    try {
      await migrateLegacy()
    } catch {
      onMigrationError?.('기존 브라우저 기록을 서버로 옮기지 못했습니다. 원본은 보존되며 새로고침 시 다시 시도합니다.')
    }
    const records = []
    let cursor: string | undefined
    do {
      const page = await historyApi.list(cursor)
      records.push(...page.sessions)
      cursor = page.next_cursor ?? undefined
    } while (cursor)
    revisions.clear()
    for (const item of records) revisions.set(item.session.id, item.revision)
    return records.map((item) => item.session).sort((a, b) => b.updatedAt - a.updatedAt)
  })
}
export function deleteSession(id: string) {
  return serialize(async () => {
    const revision = revisions.get(id)
    if (!revision) throw Error('서버에 저장되지 않은 기록입니다. 새로고침 후 다시 시도해 주세요.')
    await historyApi.delete(id, revision)
    revisions.delete(id)
  })
}
