import {
  type AuthenticationCreds,
  type AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import type Database from 'better-sqlite3';

const CREDS_TYPE = 'creds';
const CREDS_ID = 'creds';

/**
 * Baileys auth state persisted in the `auth_creds` table, scoped to one session.
 * Replaces `useMultiFileAuthState`: credentials and Signal keys live in SQLite next to the
 * session row, so deleting a session removes them in the same transaction (ON DELETE CASCADE).
 *
 * better-sqlite3 is synchronous, so writes are atomic and need no extra locking.
 */
export class SqliteAuthStore {
  constructor(
    private readonly db: Database.Database,
    private readonly sessionId: string,
  ) {}

  /** Loads (or initialises) the credentials and returns Baileys' `state` + `saveCreds`. */
  load(): { state: AuthenticationState; saveCreds: () => Promise<void> } {
    const db = this.db;
    const sessionId = this.sessionId;

    const read = db.prepare('SELECT value FROM auth_creds WHERE session_id = ? AND type = ? AND id = ?');
    const upsert = db.prepare(
      `INSERT INTO auth_creds (session_id, type, id, value) VALUES (?, ?, ?, ?)
       ON CONFLICT (session_id, type, id) DO UPDATE SET value = excluded.value`,
    );
    const remove = db.prepare('DELETE FROM auth_creds WHERE session_id = ? AND type = ? AND id = ?');

    const parse = (json: string) => JSON.parse(json, BufferJSON.reviver);
    const stringify = (v: unknown) => JSON.stringify(v, BufferJSON.replacer);

    const stored = read.get(sessionId, CREDS_TYPE, CREDS_ID) as { value: string } | undefined;
    const creds: AuthenticationCreds = stored ? parse(stored.value) : initAuthCreds();

    const writeKeys = db.transaction((data: Record<string, Record<string, unknown>>) => {
      for (const [type, entries] of Object.entries(data)) {
        for (const [id, value] of Object.entries(entries)) {
          if (value) upsert.run(sessionId, type, id, stringify(value));
          else remove.run(sessionId, type, id);
        }
      }
    });

    return {
      state: {
        creds,
        keys: {
          get: async (type, ids) => {
            const out: { [id: string]: SignalDataTypeMap[typeof type] } = {};
            for (const id of ids) {
              const row = read.get(sessionId, type, id) as { value: string } | undefined;
              let value = row ? parse(row.value) : null;
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              out[id] = value;
            }
            return out;
          },
          set: async (data) => {
            writeKeys(data as Record<string, Record<string, unknown>>);
          },
        },
      },
      saveCreds: async () => {
        upsert.run(sessionId, CREDS_TYPE, CREDS_ID, stringify(creds));
      },
    };
  }

  /** Deletes every stored credential and key of the session (used on logout). */
  clear(): void {
    this.db.prepare('DELETE FROM auth_creds WHERE session_id = ?').run(this.sessionId);
  }
}
