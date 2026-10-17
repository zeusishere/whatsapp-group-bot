import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuthUser } from '../auth/auth.types.js';
import { DatabaseService } from '../database/database.service.js';
import { ConnectionState, DesiredState } from '../whatsapp/whatsapp.types.js';

export interface SessionRecord {
  id: string;
  ownerId: string;
  label: string | null;
  jid: string | null;
  lid: string | null;
  status: ConnectionState;
  desiredState: DesiredState;
  lastDisconnectCode: number | null;
  lastConnectedAt: number | null;
  lastSeenAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type SessionPatch = Partial<Omit<SessionRecord, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'>>;

interface SessionRow {
  id: string;
  owner_id: string;
  label: string | null;
  jid: string | null;
  lid: string | null;
  status: ConnectionState;
  desired_state: DesiredState;
  last_disconnect_code: number | null;
  last_connected_at: number | null;
  last_seen_at: number | null;
  created_at: number;
  updated_at: number;
}

const COLUMNS: Record<keyof SessionPatch, string> = {
  label: 'label',
  jid: 'jid',
  lid: 'lid',
  status: 'status',
  desiredState: 'desired_state',
  lastDisconnectCode: 'last_disconnect_code',
  lastConnectedAt: 'last_connected_at',
  lastSeenAt: 'last_seen_at',
};

const toRecord = (r: SessionRow): SessionRecord => ({
  id: r.id,
  ownerId: r.owner_id,
  label: r.label,
  jid: r.jid,
  lid: r.lid,
  status: r.status,
  desiredState: r.desired_state,
  lastDisconnectCode: r.last_disconnect_code,
  lastConnectedAt: r.last_connected_at,
  lastSeenAt: r.last_seen_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

@Injectable()
export class SessionsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.connection;
  }

  create(ownerId: string, label: string | null): SessionRecord {
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO sessions (id, owner_id, label, status, desired_state, created_at, updated_at)
         VALUES (?, ?, ?, 'disconnected', 'stopped', ?, ?)`,
      )
      .run(id, ownerId, label, now, now);
    return this.findById(id)!;
  }

  findById(id: string): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** Admins see every session, everyone else only their own. */
  listFor(user: AuthUser): SessionRecord[] {
    const rows =
      user.role === 'admin'
        ? this.db.prepare('SELECT * FROM sessions ORDER BY created_at').all()
        : this.db.prepare('SELECT * FROM sessions WHERE owner_id = ? ORDER BY created_at').all(user.id);
    return (rows as SessionRow[]).map(toRecord);
  }

  countByOwner(ownerId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE owner_id = ?').get(ownerId) as { n: number }
    ).n;
  }

  /**
   * Loads a session the user may access. Unknown ids and other users' sessions both yield 404,
   * so ids can't be probed.
   */
  requireAccessible(id: string, user: AuthUser): SessionRecord {
    const rec = this.findById(id);
    if (!rec || (user.role !== 'admin' && rec.ownerId !== user.id)) {
      throw new NotFoundException(`Session ${id} not found`);
    }
    return rec;
  }

  /** Partial update. A no-op once the database is closed (shutdown) or the session is gone. */
  update(id: string, patch: SessionPatch): void {
    if (!this.database.isOpen) return;
    const keys = Object.keys(patch) as (keyof SessionPatch)[];
    if (!keys.length) return;
    const sets = keys.map((k) => `${COLUMNS[k]} = @${k}`);
    this.db
      .prepare(`UPDATE sessions SET ${sets.join(', ')}, updated_at = @updatedAt WHERE id = @id`)
      .run({ ...patch, id, updatedAt: Date.now() });
  }

  /** Refreshes `last_seen_at` for sessions that are currently connected. */
  touch(ids: string[], at: number): void {
    if (!ids.length || !this.database.isOpen) return;
    const stmt = this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?');
    this.db.transaction(() => ids.forEach((id) => stmt.run(at, id)))();
  }

  /** Cascades to the session's stored credentials. Messages are removed separately. */
  delete(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  /** After a crash or restart no socket is alive, whatever the table last said. */
  resetStaleStatuses(): number {
    return this.db
      .prepare(
        `UPDATE sessions SET status = 'disconnected', updated_at = ?
         WHERE status IN ('connected', 'connecting', 'qr_pending')`,
      )
      .run(Date.now()).changes;
  }

  /** Sessions that should be re-opened on boot: wanted connected and already paired with a phone. */
  listToRestore(): SessionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM sessions s
         WHERE s.desired_state = 'connected'
           AND EXISTS (
             SELECT 1 FROM auth_creds c
             WHERE c.session_id = s.id AND c.type = 'creds' AND c.id = 'creds'
               AND json_extract(c.value, '$.me.id') IS NOT NULL
           )
         ORDER BY s.created_at`,
      )
      .all() as SessionRow[];
    return rows.map(toRecord);
  }
}
