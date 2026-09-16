import { openDB, type DBSchema } from 'idb'
import type { Session } from '../types'
interface HistoryDB extends DBSchema { sessions: { key: string; value: Session } }
const database = () => openDB<HistoryDB>('rabbit-hole', 1, { upgrade(db) { db.createObjectStore('sessions', { keyPath: 'id' }) } })
export async function saveSession(session: Session) {
  const db = await database()
  await db.put('sessions', structuredClone(session)); db.close()
}
export async function loadSessions() {
  const db = await database(); const values = await db.getAll('sessions'); db.close()
  return values.sort((a, b) => b.updatedAt - a.updatedAt)
}
export async function deleteSession(id: string) {
  const db = await database(); await db.delete('sessions', id); db.close()
}
