import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/env.schema.js';
import { DatabaseService } from '../database/database.service.js';

export interface StoredMessage {
  id: string;
  groupId: string;
  senderId: string;
  senderName: string | null;
  text: string;
  timestamp: number;
  isBot: boolean;
  quotedMessageId: string | null;
  quotedParticipant: string | null;
  mentionedJids: string[];
}

export interface GroupSummary {
  groupId: string;
  messageCount: number;
  lastTimestamp: number;
}

export interface GroupMember {
  jid: string;
  handle: string;
  name: string | null;
}

export function jidHandle(jid: string): string {
  return jid.split('@')[0]?.split(':')[0]?.trim() ?? '';
}

export function normalizeJid(jid: string): string {
  const [userPart, domain] = jid.trim().split('@');
  if (!userPart || !domain) return jid.trim();
  return `${userPart.split(':')[0]}@${domain}`;
}

interface MessageRow {
  id: string;
  group_id: string;
  sender_id: string;
  sender_name: string | null;
  text: string;
  timestamp: number;
  is_bot: number;
  quoted_message_id: string | null;
  quoted_participant: string | null;
  mentioned_jids: string;
}

function toMessage(r: MessageRow): StoredMessage {
  return {
    id: r.id,
    groupId: r.group_id,
    senderId: r.sender_id,
    senderName: r.sender_name,
    text: r.text,
    timestamp: r.timestamp,
    isBot: r.is_bot === 1,
    quotedMessageId: r.quoted_message_id,
    quotedParticipant: r.quoted_participant,
    mentionedJids: JSON.parse(r.mentioned_jids) as string[],
  };
}

/** Called after a message has been newly stored (not for duplicates). Must not throw. */
export type MessageInsertedListener = (sessionId: string, message: StoredMessage) => void;

@Injectable()
export class MessagesRepository {
  private readonly insertListeners: MessageInsertedListener[] = [];

  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** Inserts a message (ignored if already stored) and trims the group to the retention cap. */
  insert(sessionId: string, m: StoredMessage): boolean {
    const db = this.database.connection;
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO messages
           (session_id, id, group_id, sender_id, sender_name, text, timestamp, is_bot,
            quoted_message_id, quoted_participant, mentioned_jids)
         VALUES (@sessionId, @id, @groupId, @senderId, @senderName, @text, @timestamp, @isBot,
                 @quotedMessageId, @quotedParticipant, @mentionedJids)`,
      )
      .run({
        ...m,
        sessionId,
        isBot: m.isBot ? 1 : 0,
        mentionedJids: JSON.stringify(m.mentionedJids),
      });
    if (res.changes > 0) {
      this.trim(sessionId, m.groupId);
      for (const listener of this.insertListeners) {
        try {
          listener(sessionId, m);
        } catch {
          // A faulty observer (e.g. the embedding queue) must never lose the message itself.
        }
      }
    }
    return res.changes > 0;
  }

  /** Subscribes to newly stored messages. Used to index them for retrieval without coupling ingestion to it. */
  onInserted(listener: MessageInsertedListener): void {
    this.insertListeners.push(listener);
  }

  /** Loads several messages of a group by id (order not guaranteed). */
  getByIds(sessionId: string, groupId: string, ids: string[]): StoredMessage[] {
    if (!ids.length) return [];
    const marks = ids.map(() => '?').join(',');
    const rows = this.database.connection
      .prepare(`SELECT * FROM messages WHERE session_id = ? AND group_id = ? AND id IN (${marks})`)
      .all(sessionId, groupId, ...ids) as MessageRow[];
    return rows.map(toMessage);
  }

  /** Keeps only the newest N messages for a group of a session (NFR-3). */
  private trim(sessionId: string, groupId: string): void {
    const max = this.config.get('database', { infer: true }).maxMessagesPerGroup;
    this.database.connection
      .prepare(
        `DELETE FROM messages
         WHERE session_id = ? AND group_id = ?
           AND rowid NOT IN (
             SELECT rowid FROM messages WHERE session_id = ? AND group_id = ?
             ORDER BY timestamp DESC, rowid DESC LIMIT ?
           )`,
      )
      .run(sessionId, groupId, sessionId, groupId, max);
  }

  /**
   * Lists a session's messages, newest first. Optionally filtered by group and paginated with
   * `before` (exclusive upper bound on timestamp, epoch ms).
   */
  list(opts: { sessionId: string; groupId?: string; limit: number; before?: number }): StoredMessage[] {
    const where: string[] = ['session_id = @sessionId'];
    const params: Record<string, unknown> = { sessionId: opts.sessionId, limit: opts.limit };
    if (opts.groupId) {
      where.push('group_id = @groupId');
      params.groupId = opts.groupId;
    }
    if (opts.before !== undefined) {
      where.push('timestamp < @before');
      params.before = opts.before;
    }
    const sql = `SELECT * FROM messages
                 WHERE ${where.join(' AND ')}
                 ORDER BY timestamp DESC, rowid DESC LIMIT @limit`;
    const rows = this.database.connection.prepare(sql).all(params) as MessageRow[];
    return rows.map(toMessage);
  }

  findById(sessionId: string, groupId: string, id: string): StoredMessage | null {
    const row = this.database.connection
      .prepare('SELECT * FROM messages WHERE session_id = ? AND group_id = ? AND id = ?')
      .get(sessionId, groupId, id) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  }

  listGroups(sessionId: string): GroupSummary[] {
    return this.database.connection
      .prepare(
        `SELECT group_id AS groupId, COUNT(*) AS messageCount, MAX(timestamp) AS lastTimestamp
         FROM messages WHERE session_id = ? GROUP BY group_id ORDER BY lastTimestamp DESC`,
      )
      .all(sessionId) as GroupSummary[];
  }

  listGroupMembers(sessionId: string, groupId: string, excludeJids: string[] = []): GroupMember[] {
    const db = this.database.connection;
    const sessionRow = db
      .prepare('SELECT jid, lid FROM sessions WHERE id = ?')
      .get(sessionId) as { jid: string | null; lid: string | null } | undefined;
    const botRows = db
      .prepare('SELECT DISTINCT sender_id FROM messages WHERE session_id = ? AND is_bot = 1')
      .all(sessionId) as Array<{ sender_id: string }>;

    const excluded = new Set<string>();
    for (const raw of [
      ...excludeJids,
      sessionRow?.jid ?? '',
      sessionRow?.lid ?? '',
      ...botRows.map((r) => r.sender_id),
    ]) {
      if (!raw) continue;
      const norm = normalizeJid(raw);
      const handle = jidHandle(norm);
      if (norm) excluded.add(norm);
      if (handle) excluded.add(handle);
    }

    const nameByHandle = new Map<string, string>();
    const nameRows = db
      .prepare(
        `SELECT sender_id, sender_name FROM messages
         WHERE session_id = ? AND is_bot = 0 AND sender_name IS NOT NULL AND trim(sender_name) != ''
         ORDER BY timestamp DESC, rowid DESC`,
      )
      .all(sessionId) as Array<{ sender_id: string; sender_name: string }>;
    for (const r of nameRows) {
      const handle = jidHandle(r.sender_id);
      if (handle && !nameByHandle.has(handle)) {
        nameByHandle.set(handle, r.sender_name.trim());
      }
    }

    const byHandle = new Map<string, GroupMember>();
    const addCandidate = (rawJid: string, rawName?: string | null) => {
      if (!rawJid || rawJid.endsWith('@g.us')) return;
      const jid = normalizeJid(rawJid);
      const handle = jidHandle(jid);
      if (!handle || !jid.includes('@') || excluded.has(jid) || excluded.has(handle)) return;
      const candidateName = rawName?.trim() || nameByHandle.get(handle) || null;
      const existing = byHandle.get(handle);
      if (!existing) {
        byHandle.set(handle, { jid, handle, name: candidateName });
      } else if (!existing.name && candidateName) {
        existing.name = candidateName;
      }
    };

    const groupRows = db
      .prepare(
        `SELECT sender_id, sender_name, is_bot, mentioned_jids FROM messages
         WHERE session_id = ? AND group_id = ?
         ORDER BY timestamp DESC, rowid DESC`,
      )
      .all(sessionId, groupId) as Array<{
      sender_id: string;
      sender_name: string | null;
      is_bot: number;
      mentioned_jids: string;
    }>;

    for (const row of groupRows) {
      if (!row.is_bot) {
        addCandidate(row.sender_id, row.sender_name);
      }
      if (row.mentioned_jids) {
        try {
          const parsed = JSON.parse(row.mentioned_jids) as unknown;
          if (Array.isArray(parsed)) {
            for (const m of parsed) {
              if (typeof m === 'string' && nameByHandle.has(jidHandle(m))) {
                addCandidate(m);
              }
            }
          }
        } catch {
          // ignore malformed mentioned_jids
        }
      }
    }

    return [...byHandle.values()];
  }

  deleteBySession(sessionId: string): number {
    return this.database.connection.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId).changes;
  }
}
