import type { HistoryWrite, Session } from '../../src/types'

// In-memory HTTP boundary for canvas unit tests. db.test.ts exercises real HTTP requests.
export function memoryHistoryApi() {
  const rows = new Map<string, HistoryWrite>()
  const deleted = new Set<string>()
  return {
    list: async () => ({ sessions: structuredClone([...rows.values()]) }),
    get: async (id: string) => {
      const record = rows.get(id)
      if (!record) throw Error('not_found')
      return structuredClone(record)
    },
    save: async (id: string, body: HistoryWrite) => {
      if (deleted.has(id) || (rows.get(id)?.revision ?? 0) !== body.revision) throw Error('conflict')
      const revision = body.revision + 1
      rows.set(id, { session: structuredClone(body.session), revision })
      return { revision }
    },
    import: async (session: Session) => {
      const imported = !rows.has(session.id) && !deleted.has(session.id)
      if (imported) rows.set(session.id, { session: structuredClone(session), revision: 1 })
      return { imported }
    },
    delete: async (id: string, revision: number) => {
      if (rows.get(id)?.revision !== revision) throw Error('conflict')
      rows.delete(id)
      deleted.add(id)
    },
  }
}
